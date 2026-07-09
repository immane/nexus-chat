export interface IceServerConfig {
  stunServers: string;
  turnServers: string;
  turnUsername: string;
  turnCredential: string;
}

export interface PeerTransportState {
  mode: "p2p" | "relay";
  p2pFailedAt?: number;
}

export interface P2pMessageFrame {
  type: "e2ee.message";
  clientMsgId: string;
  workspaceId: string;
  channelId: string;
  content: {
    type: "ciphertext";
    ciphertext: string;
    algorithm: string;
    senderDeviceId: string;
    readOnce?: boolean;
    expiresAt?: string;
    attachments: Array<{ fileId: string; name: string; mimeType: string; size: number; scanStatus: string }>;
  };
  timestamp: string;
}

export interface P2pAckFrame {
  type: "e2ee.ack";
  clientMsgId: string;
  messageId: string;
}

export const P2P_RELAY_COOLDOWN_MS = 30_000;
export const P2P_CONNECTION_TIMEOUT_MS = 5_000;
