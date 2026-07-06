import type { IceServerConfig } from "./types.js";

const envValue = (key: string): string => {
  const viteEnv = import.meta.env[key];
  if (typeof viteEnv === "string") return viteEnv;
  const nodeProcess = globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } };
  return nodeProcess.process?.env?.[key] ?? "";
};

export const getIceServerConfig = (): IceServerConfig => ({
  stunServers: envValue("VITE_NEXUS_STUN_SERVERS") || envValue("NEXUS_STUN_SERVERS") || "stun:stun.l.google.com:19302",
  turnServers: envValue("VITE_NEXUS_TURN_SERVERS") || envValue("NEXUS_TURN_SERVERS"),
  turnUsername: envValue("VITE_NEXUS_TURN_USERNAME") || envValue("NEXUS_TURN_USERNAME"),
  turnCredential: envValue("VITE_NEXUS_TURN_CREDENTIAL") || envValue("NEXUS_TURN_CREDENTIAL")
});

export const buildRtcConfiguration = (): RTCConfiguration => {
  const config = getIceServerConfig();
  const iceServers: RTCIceServer[] = [];

  if (config.stunServers) {
    config.stunServers.split(",").forEach((url) => {
      if (url.trim()) iceServers.push({ urls: url.trim() });
    });
  }

  if (config.turnServers && config.turnUsername && config.turnCredential) {
    config.turnServers.split(",").forEach((url) => {
      if (url.trim()) {
        iceServers.push({
          urls: url.trim(),
          username: config.turnUsername,
          credential: config.turnCredential
        });
      }
    });
  }

  if (iceServers.length === 0) {
    iceServers.push({ urls: "stun:stun.l.google.com:19302" });
  }

  return { iceServers };
};
