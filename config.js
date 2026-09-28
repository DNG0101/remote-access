const params = new URLSearchParams(location.search);
const signalFromUrl = params.get("signal");

window.P2P_DESK_CONFIG = {
  appVersion: "0.3.2",
  protocolVersion: "1.1.0",
  signalingUrl: signalFromUrl || "wss://wss.getlost.ovh",
  signalingMode: "wss-room-relay",
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302"] }
  ],
  sessionTtlMinutes: 30,
  maxFileBytes: 25 * 1024 * 1024
};
