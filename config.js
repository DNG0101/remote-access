const params = new URLSearchParams(location.search);
const signalFromUrl = params.get("signal");

window.P2P_DESK_CONFIG = {
  appVersion: "0.6.0",
  protocolVersion: "2.0.0",
  signalingUrl: signalFromUrl || "wss://wss.getlost.ovh",
  signalingMode: "wss-room-relay",
  agentUrl: params.get("agent") || "ws://127.0.0.1:17878",
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302"] }
  ],
  sessionTtlMinutes: 30,
  maxFileBytes: 2 * 1024 * 1024 * 1024,
  maxFileChunks: 16384,
  fileChunkBytes: 256 * 1024,
  fileBufferedAmount: 4 * 1024 * 1024,
  fileTransferTimeoutMs: 30 * 1000,
  fileStreamingThresholdBytes: 32 * 1024 * 1024
};
