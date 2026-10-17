// Orderly bridge: an optional integration that connects Hub rooms to an
// external Orderly service. DISABLED by default — it requires a verified
// API contract before activation.

export const ORDERLY_DEFAULTS = {
  enabled: false,
  contractVerified: false,
  endpoint: null,
  apiKeyEnv: null,
};

export function orderlyConfig(env = process.env) {
  const enabled = env.A2AHUB_ORDERLY_ENABLED === "1" && !!env.A2AHUB_ORDERLY_ENDPOINT;
  const contractVerified = enabled && env.A2AHUB_ORDERLY_CONTRACT_VERIFIED === "1";
  return {
    enabled,
    contractVerified,
    endpoint: env.A2AHUB_ORDERLY_ENDPOINT || null,
    apiKeyEnv: env.A2AHUB_ORDERLY_API_KEY_ENV || null,
  };
}

export function orderlyBridgeActive(config = orderlyConfig()) {
  return config.enabled && config.contractVerified;
}

export function orderlyRoomLink(config, roomId) {
  if (!orderlyBridgeActive(config)) return null;
  return `${config.endpoint}/rooms/${roomId}`;
}
