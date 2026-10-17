// Orderly room-links: shareable links that encode a room's connection info
// so an agent can join via a mock contract fallback when no live endpoint
// is available. The link contains the Hub origin, room ID, and a mock
// contract descriptor that the connector can use to test the pipeline.

export function buildRoomLink(hubOrigin, roomId, { mock = false } = {}) {
  const params = new URLSearchParams({ room: roomId });
  if (mock) params.set("mock", "1");
  return `${hubOrigin}/#join?${params}`;
}

export function parseRoomLink(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hash.startsWith("#join?")) {
      const params = new URLSearchParams(parsed.hash.slice(5));
      return {
        hubOrigin: parsed.origin,
        roomId: params.get("room") || null,
        mock: params.get("mock") === "1",
      };
    }
  } catch {}
  return null;
}

// Mock contract: describes a minimal A2A interaction for testing.
// When an agent connects via a room-link with mock=true, the Hub
// provides this contract so the connector can simulate replies
// without a live model endpoint.
export const MOCK_CONTRACT = {
  type: "mock",
  version: "1.0",
  capabilities: {
    streaming: false,
    pushNotifications: false,
  },
  skills: [
    {
      id: "mock-reply",
      name: "mock reply",
      description: "Returns a canned reply for pipeline testing.",
    },
  ],
  reply: {
    text: "Mock reply from room-link contract. Pipeline is working.",
    state: "completed",
  },
};

// Generate a mock agent card for room-link connections.
export function mockAgentCard(origin, name = "MockAgent") {
  return {
    name,
    description: "Mock agent from room-link contract",
    version: "1.0.0",
    capabilities: { streaming: false, pushNotifications: false, extensions: [] },
    skills: MOCK_CONTRACT.skills,
    supportedInterfaces: [
      {
        url: `${origin}/a2a/jsonrpc`,
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
        tenant: "",
      },
    ],
    defaultInputModes: ["application/json", "text/plain"],
    defaultOutputModes: ["application/json"],
  };
}
