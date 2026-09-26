import { randomUUID } from "node:crypto";
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
} from "@a2a-js/sdk/server";
import { agentCardHandler, jsonRpcHandler } from "@a2a-js/sdk/server/express";
import { Role } from "@a2a-js/sdk";

export function mountInbound(
  app,
  { access, db, publish, origin, broker, onPost },
) {
  const card = {
    name: "A2Ahub",
    description:
      "Human-approved conversation access. Request a credential at /auth/device, show the verification link to the human, then poll /auth/token. The owner adds your reusable identity to conversations. Use list_rooms, read_messages and post_message; connectors use next_dispatch and report_dispatch to receive authorized turns and return replies.",
    version: "1.1.0",
    supportedInterfaces: [
      {
        url: `${origin}/a2a/jsonrpc`,
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
        tenant: "",
      },
    ],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [],
      extendedAgentCard: false,
    },
    defaultInputModes: ["application/json", "text/plain"],
    defaultOutputModes: ["application/json"],
    securitySchemes: {
      bearer: {
        scheme: {
          $case: "httpAuthSecurityScheme",
          value: {
            scheme: "bearer",
            bearerFormat: "hub_",
            description: "Issued after human device approval",
          },
        },
      },
    },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    skills: [
      "list_rooms",
      "read_messages",
      "post_message",
      "next_dispatch",
      "report_dispatch",
    ].map((id) => ({
      id,
      name: id.replaceAll("_", " "),
      description: {
        list_rooms:
          "List the conversations the owner has added you to using {action:list_rooms}.",
        read_messages:
          "Read new shared messages using {action:read_messages,roomId:...,cursor:0}. The room must be explicitly assigned by the owner.",
        post_message:
          "Post using {action:post_message,roomId:...,text:...}. A post does not grant permission for automatic model work.",
        next_dispatch:
          "Connectors poll for an authorized turn using {action:next_dispatch,connectorId:...,available:true}. When busy, poll with available:false for cancellations. No model work starts merely by polling.",
        report_dispatch:
          "Connectors report progress or a final result using {action:report_dispatch,dispatchId:...,leaseId:...,connectorId:...,kind:...,result:{text,state,contextId}}.",
      }[id],
      tags: ["chat"],
      examples: [],
      inputModes: ["application/json"],
      outputModes: ["application/json"],
      securityRequirements: [],
    })),
  };
  const executor = {
    async execute(ctx, bus) {
      let account = ctx.context.user.account;
      let result;
      let contextId = "";
      try {
        account = access.authenticate(ctx.context.user.authorization);
        access.limit(`a2a:${account.id}`, 120, 60000);
        const part = ctx.userMessage.parts.find(
          (p) => p.content?.$case === "data",
        );
        const text = ctx.userMessage.parts
          .filter((p) => p.content?.$case === "text")
          .map((p) => p.content.value)
          .join("\n");
        const command = part?.content.value || { action: "post_message", text };
        if (!command || typeof command !== "object" || Array.isArray(command))
          throw new Error("Enter an A2A action object.");
        const requireRoom = (roomId) => {
          const room = db.rooms.find((r) => r.id === roomId);
          if (
            !room ||
            !access.canAccess(account.id, roomId) ||
            !room.agentIds?.includes(account.id)
          )
            throw new Error("Conversation access denied.");
          return room;
        };
        if (command.action === "list_rooms") {
          result = { rooms: access.rooms(account, db.rooms) };
        } else if (command.action === "next_dispatch") {
          if (!broker)
            throw new Error("Agent connector delivery is unavailable.");
          if (command.roomId) requireRoom(command.roomId);
          result = await broker.next(account, command);
          // A long poll may outlive revocation or a membership change.
          account = access.authenticate(ctx.context.user.authorization);
          if (result.dispatch) {
            const room = requireRoom(result.dispatch.roomId);
            if (room.paused)
              throw new Error("Conversation is paused by the owner.");
            contextId = room.id;
          }
        } else if (command.action === "report_dispatch") {
          if (!broker)
            throw new Error("Agent connector delivery is unavailable.");
          result = await broker.report(account, command);
        } else {
          const roomId =
            command.roomId || ctx.userMessage.contextId || account.roomId;
          const room = requireRoom(roomId);
          // roomId is the Hub routing key. The A2A SDK creates its own
          // context when a caller omits one, so do not treat that opaque
          // protocol context as a second permission boundary.
          contextId = room.id;
          if (command.action === "read_messages") {
            const startIndex = account.bindings[room.id];
            const cursor = command.cursor ?? startIndex;
            if (
              !Number.isInteger(cursor) ||
              cursor < 0 ||
              cursor > room.messages.length
            )
              throw new Error("Invalid message cursor.");
            const start = Math.max(cursor, startIndex);
            const inAudience = (m) =>
              !m.recipientIds ||
              m.recipientIds.includes(account.id) ||
              m.inboundAccountId === account.id ||
              m.agentId === account.id;
            let end = Math.min(start + 100, room.messages.length);
            // Do not advance past a shared reply that is still being streamed.
            // Otherwise polling could permanently miss its final text.
            for (let i = start; i < end; i++) {
              const m = room.messages[i];
              if (
                m.role === "agent" &&
                m.shared &&
                inAudience(m) &&
                ["working", "submitted"].includes(m.state)
              ) {
                end = i;
                break;
              }
            }
            const messages = room.messages
              .slice(start, end)
              .filter(
                (m) =>
                  inAudience(m) &&
                  (m.role === "user" ||
                    (m.role === "agent" &&
                      (m.shared ||
                        m.inboundAccountId === account.id ||
                        m.agentId === account.id) &&
                      m.state === "completed")),
              )
              .map(({ id, name, role, text, createdAt }) => ({
                id,
                name,
                role,
                text,
                createdAt,
              }));
            result = {
              context_id: room.id,
              messages,
              next_cursor: end,
              paused: room.paused,
            };
          } else if (command.action === "post_message") {
            if (room.paused)
              throw new Error("Conversation is paused by the owner.");
            if (
              typeof command.text !== "string" ||
              !command.text.trim() ||
              command.text.length > 12000
            )
              throw new Error("Enter 1–12,000 characters.");
            const duplicate = room.messages.find(
              (m) =>
                m.inboundAccountId === account.id &&
                m.clientMessageId === ctx.userMessage.messageId,
            );
            if (duplicate) {
              if (duplicate.text !== command.text.trim())
                throw new Error(
                  "messageId already used for different content.",
                );
              result = {
                message_id: duplicate.id,
                context_id: room.id,
                duplicate: true,
              };
            } else {
              const message = {
                id: randomUUID(),
                role: "agent",
                name: account.name,
                text: command.text.trim(),
                state: "completed",
                shared: !!room.agentChat,
                agentId: account.id,
                recipientIds: room.agentChat
                  ? [...room.agentIds]
                  : [account.id],
                inboundAccountId: account.id,
                clientMessageId: ctx.userMessage.messageId,
                createdAt: new Date().toISOString(),
              };
              room.messages.push(message);
              onPost?.(room, message);
              publish();
              result = { message_id: message.id, context_id: room.id };
            }
          } else
            throw new Error(
              "Unknown action. Use list_rooms, read_messages, post_message, next_dispatch or report_dispatch.",
            );
        }
      } catch (error) {
        result = { error: error.message };
      }
      bus.publish(
        AgentEvent.message({
          messageId: randomUUID(),
          role: Role.ROLE_AGENT,
          contextId,
          taskId: "",
          parts: [
            {
              content: { $case: "data", value: result },
              mediaType: "application/json",
              filename: "",
            },
          ],
          extensions: [],
          referenceTaskIds: [],
        }),
      );
      bus.finished();
    },
    async cancelTask() {
      throw new Error(
        "No long-running tasks: requests return messages immediately.",
      );
    },
  };
  app.use(
    "/.well-known/agent-card.json",
    agentCardHandler({ agentCardProvider: async () => card }),
  );
  app.use(
    "/a2a/jsonrpc",
    (req, res, next) => {
      try {
        res.locals.account = access.authenticate(req.headers.authorization);
        next();
      } catch (e) {
        res.status(e.status || 401).json({ error: e.message });
      }
    },
    jsonRpcHandler({
      requestHandler: new DefaultRequestHandler(
        card,
        new InMemoryTaskStore(),
        executor,
      ),
      userBuilder: async (req) => ({
        isAuthenticated: true,
        userName: req.res.locals.account.id,
        account: req.res.locals.account,
        authorization: req.headers.authorization,
      }),
    }),
  );
}
