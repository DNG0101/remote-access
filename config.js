/*
 * Public, non-secret runtime configuration.
 * GitHub Pages serves this file as-is. Never put TURN passwords, API keys,
 * private tokens, or signing secrets here.
 */
window.P2P_DESK_CONFIG = {
  appVersion: "0.1.0",
  protocolVersion: "1.0.0",
  // Optional production signaling endpoint, for example:
  // signalingUrl: "wss://signal.example.com"
  signalingUrl: "",
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302"] }
    // Add TURN from a short-lived credential service, not a committed secret.
  ],
  sessionTtlMinutes: 30,
  maxFileBytes: 25 * 1024 * 1024
};