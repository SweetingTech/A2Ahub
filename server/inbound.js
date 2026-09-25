import { randomUUID } from "node:crypto";
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
} from "@a2a-js/sdk/server";
import { agentCardHandler, jsonRpcHandler } from "@a2a-js/sdk/server/express";
import { Role } from "@a2a-js/sdk";

export function mountInbound(app, { access, db, publish, origin }) {
  const card = {
    name: "A2Ahub",
    description:
      "Human-approved shared conversation access. Request a credential at /auth/device, show the verification link to the human, then poll /auth/token. Use read_messages or post_message data parts after approval.",
    version: "1.0.0",
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
    skills: ["read_messages", "post_message"].map((id) => ({
      id,
      name: id.replaceAll("_", " "),
      description:
        id === "read_messages"
          ? "Read new messages in your approved conversation using {action:read_messages,cursor:0}."
          : "Post to your approved conversation using {action:post_message,text:...}. Does not trigger other agents automatically.",
      tags: ["chat"],
      examples: [],
      inputModes: ["application/json"],
      outputModes: ["application/json"],
      securityRequirements: [],
    })),
  };
  const executor = {
    async execute(ctx, bus) {
      const account = ctx.context.user.account;
      let result;
      try {
        access.authenticate(ctx.context.user.authorization);
        access.limit(`a2a:${account.id}`, 120, 60000);
        const room = db.rooms.find((r) => r.id === account.roomId);
        if (
          !room ||
          (ctx.userMessage.contextId && ctx.userMessage.contextId !== room.id)
        )
          throw new Error("Conversation access denied.");
        const part = ctx.userMessage.parts.find(
          (p) => p.content?.$case === "data",
        );
        const text = ctx.userMessage.parts
          .filter((p) => p.content?.$case === "text")
          .map((p) => p.content.value)
          .join("\n");
        const command = part?.content.value || { action: "post_message", text };
        if (command.action === "read_messages") {
          const cursor = command.cursor ?? account.startIndex;
          if (
            !Number.isInteger(cursor) ||
            cursor < 0 ||
            cursor > room.messages.length
          )
            throw new Error("Invalid message cursor.");
          const start = Math.max(cursor, account.startIndex);
          let end = Math.min(start + 100, room.messages.length);
          // Do not advance past a shared reply that is still being streamed.
          // Otherwise polling could permanently miss its final text.
          for (let i = start; i < end; i++) {
            const m = room.messages[i];
            if (
              m.role === "agent" &&
              m.shared &&
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
                m.role === "user" ||
                (m.role === "agent" &&
                  (m.shared || m.inboundAccountId) &&
                  m.state === "completed"),
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
              throw new Error("messageId already used for different content.");
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
              shared: true,
              inboundAccountId: account.id,
              clientMessageId: ctx.userMessage.messageId,
              createdAt: new Date().toISOString(),
            };
            room.messages.push(message);
            publish();
            result = { message_id: message.id, context_id: room.id };
          }
        } else
          throw new Error("Unknown action. Use read_messages or post_message.");
      } catch (error) {
        result = { error: error.message };
      }
      bus.publish(
        AgentEvent.message({
          messageId: randomUUID(),
          role: Role.ROLE_AGENT,
          contextId: account.roomId,
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
