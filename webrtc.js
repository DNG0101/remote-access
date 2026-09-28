const CHANNELS = ["control", "input", "clipboard", "file-transfer", "telemetry", "chat"];
const EVENTS = ["state", "ice", "signaling", "channel", "track", "stats", "message", "error"];

export class PeerSession extends EventTarget {
  constructor({ code, role, iceServers, onLog = () => {} }) {
    super();
    this.code = code;
    this.role = role;
    this.onLog = onLog;
    this.iceServers = iceServers || [];
    this.pc = null;
    this.channels = new Map();
    this.remoteStream = new MediaStream();
    this.localStream = null;
    this.room = null;
    this.isClosed = false;
    this.pendingCandidates = [];
    this.pendingMessages = new Map();
  }

  on(name, fn) { this.addEventListener(name, (event) => fn(event.detail)); return this; }
  emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail })); }

  openRoom() {
    if (this.room) return;
    const name = `p2p-desk:${this.code}`;
    const useRemoteSignaling = Boolean(window.P2P_DESK_CONFIG?.signalingUrl);
    this.room = !useRemoteSignaling && "BroadcastChannel" in window ? new BroadcastChannel(name) : null;
    if (this.room) this.room.onmessage = (event) => this.handleSignal(event.data);
    if (!this.room && !window.P2P_DESK_CONFIG?.signalingUrl) {
      throw new Error("BroadcastChannel is unavailable; configure a signalingUrl for multi-device sessions.");
    }
  }

  signal(payload) {
    if (this.room) this.room.postMessage({ ...payload, from: this.role, at: Date.now() });
    if (this.signalingSocket?.readyState === WebSocket.OPEN) this.signalingSocket.send(JSON.stringify(payload));
  }

  async connect() {
    this.openRoom();
    if (window.P2P_DESK_CONFIG?.signalingUrl) this.connectWebSocket(window.P2P_DESK_CONFIG.signalingUrl);
    if (this.role === "controller") this.signal({ type: "join", code: this.code });
    this.emit("signaling", { state: "connected", mode: this.room ? "local" : "websocket" });
    this.log("signaling_ready", { mode: this.room ? "same_origin_local" : "websocket" });
  }

  connectWebSocket(url) {
    try {
      this.signalingSocket = new WebSocket(url);
      this.signalingSocket.onopen = () => this.signalingSocket.send(JSON.stringify({ type: "join", code: this.code, role: this.role }));
      this.signalingSocket.onmessage = (event) => { try { this.handleSignal(JSON.parse(event.data)); } catch { this.log("invalid_signal", {}); } };
      this.signalingSocket.onerror = () => this.emit("error", { code: "SIGNALING_UNAVAILABLE", message: "The configured signaling service could not be reached." });
    } catch {
      this.emit("error", { code: "SIGNALING_INVALID", message: "The configured signaling URL is invalid." });
    }
  }

  createPeer() {
    if (this.pc) return this.pc;
    this.pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      const candidate = typeof event.candidate.toJSON === "function"
        ? event.candidate.toJSON()
        : { candidate: event.candidate.candidate, sdpMid: event.candidate.sdpMid, sdpMLineIndex: event.candidate.sdpMLineIndex, usernameFragment: event.candidate.usernameFragment };
      this.signal({ type: "candidate", candidate });
    };
    this.pc.onconnectionstatechange = () => {
      this.emit("state", this.pc.connectionState);
      this.log("connection_state", { state: this.pc.connectionState });
    };
    this.pc.oniceconnectionstatechange = () => this.emit("ice", this.pc.iceConnectionState);
    this.pc.onsignalingstatechange = () => this.emit("signaling", { state: this.pc.signalingState });
    this.pc.ontrack = (event) => {
      event.streams?.[0]?.getTracks().forEach((track) => this.remoteStream.addTrack(track));
      this.emit("track", { stream: this.remoteStream, track: event.track });
    };
    this.pc.ondatachannel = (event) => this.attachChannel(event.channel);
    return this.pc;
  }

  attachChannel(channel) {
    this.channels.set(channel.label, channel);
    channel.onopen = () => {
      const queued = this.pendingMessages.get(channel.label) || [];
      queued.forEach((message) => channel.send(message));
      this.pendingMessages.delete(channel.label);
      this.emit("channel", { name: channel.label, state: "open" });
      this.log("channel_open", { channel: channel.label });
    };
    channel.onclose = () => this.emit("channel", { name: channel.label, state: "closed" });
    channel.onerror = () => this.emit("error", { code: "CHANNEL_ERROR", message: `${channel.label} channel error` });
    channel.onmessage = (event) => this.emit("message", { channel: channel.label, data: event.data });
  }

  createChannels() {
    CHANNELS.forEach((name) => {
      if (!this.channels.has(name)) this.attachChannel(this.pc.createDataChannel(name, { ordered: name !== "input" }));
    });
  }

  async accept({ stream = null } = {}) {
    const pc = this.createPeer();
    this.createChannels();
    if (stream) {
      this.localStream = stream;
      stream.getTracks().forEach((track) => {
        if (!pc.getSenders().some((sender) => sender.track?.kind === track.kind)) pc.addTrack(track, stream);
      });
    }
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.signal({ type: "offer", description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
    this.log("offer_sent", {});
  }

  async handleSignal(message) {
    if (!message || message.from === this.role || message.code && message.code !== this.code) return;
    try {
      if (message.type === "join" && this.role === "host") {
        this.emit("message", { channel: "system", data: JSON.stringify({ type: "peer_joined" }) });
        return;
      }
      if (message.type === "offer" && this.role === "controller") {
        const pc = this.createPeer();
        await pc.setRemoteDescription(message.description);
        for (const candidate of this.pendingCandidates.splice(0)) await pc.addIceCandidate(candidate);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.signal({ type: "answer", description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
        this.log("answer_sent", {});
      } else if (message.type === "answer" && this.role === "host" && this.pc) {
        await this.pc.setRemoteDescription(message.description);
        for (const candidate of this.pendingCandidates.splice(0)) await this.pc.addIceCandidate(candidate);
        this.log("answer_received", {});
      } else if (message.type === "candidate") {
        if (!this.pc || !this.pc.remoteDescription) {
          this.pendingCandidates.push(message.candidate);
        } else {
          await this.pc.addIceCandidate(message.candidate);
        }
      } else if (message.type === "control-request") {
        this.emit("message", { channel: "control", data: JSON.stringify(message) });
      }
    } catch (error) {
      this.emit("error", { code: "SIGNALING_HANDSHAKE_FAILED", message: error.message });
      this.log("handshake_error", { reason: error.message });
    }
  }

  send(channel, message) {
    const target = this.channels.get(channel);
    const payload = typeof message === "string" ? message : JSON.stringify(message);
    if (!target || target.readyState === "connecting") {
      const queue = this.pendingMessages.get(channel) || [];
      if (queue.length >= 20) queue.shift();
      queue.push(payload);
      this.pendingMessages.set(channel, queue);
      return true;
    }
    if (target.readyState !== "open") return false;
    target.send(payload);
    return true;
  }

  async getStats() {
    if (!this.pc) return null;
    const reports = await this.pc.getStats();
    const result = { rtt: null, bitrate: null, fps: null, route: "unknown" };
    reports.forEach((stat) => {
      if (stat.type === "candidate-pair" && stat.state === "succeeded") {
        result.rtt = stat.currentRoundTripTime != null ? Math.round(stat.currentRoundTripTime * 1000) : null;
        const local = stat.localCandidateId && reports.get(stat.localCandidateId);
        result.route = local?.candidateType === "relay" ? "relay" : (local?.candidateType || "direct");
      }
      if (stat.type === "inbound-rtp" && stat.kind === "video") {
        result.fps = stat.framesPerSecond ? Math.round(stat.framesPerSecond) : null;
        result.bitrate = stat.bytesReceived ? Math.round((stat.bytesReceived * 8) / 1000) : null;
      }
    });
    this.emit("stats", result);
    return result;
  }

  close() {
    this.isClosed = true;
    this.channels.forEach((channel) => channel.close());
    this.pc?.close();
    this.room?.close();
    this.signalingSocket?.close();
    this.emit("state", "closed");
  }

  log(event, detail) { this.onLog({ event, detail, at: new Date().toISOString() }); }
}

export function validateInputMessage(message) {
  return Boolean(message && typeof message === "object" && ["mouse_move", "mouse_button", "scroll", "keyboard"].includes(message.type));
}