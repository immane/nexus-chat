import type { IceServerConfig } from "./types.js";

export const getIceServerConfig = (): IceServerConfig => ({
  stunServers: process.env.NEXUS_STUN_SERVERS ?? "stun:stun.l.google.com:19302",
  turnServers: process.env.NEXUS_TURN_SERVERS ?? "",
  turnUsername: process.env.NEXUS_TURN_USERNAME ?? "",
  turnCredential: process.env.NEXUS_TURN_CREDENTIAL ?? ""
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
