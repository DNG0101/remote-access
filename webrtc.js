import {
  CHANNELS,
  makePeerId,
  validateDataChannelMessage,
  calculateBitrate,
  MAX_PENDING_CANDIDATES,
  MAX_PENDING_MESSAGES
} from "./protocol.js";

const EVENTS = ["state","ice","signaling","channel","track","stats","message","error"];
const MAX_SIGNAL_BYTES = 256 * 1024;

export class PeerSession extends EventTarget {
  constructor({ code, role, iceServers = [], signalingUrl = "", onLog = () => {} }) {
    super();
    this.code = code;
    this.role = role;
    this.peerId = makePeerId();
    this.onLog = onLog;
    this.iceServers = Array.isArray(iceServers) ? iceServers : [];
    this.signalingUrl = signalingUrl;
    this.signalingSocket = null;
    this.remotePeerId = "";
    this.remoteRole = "";
    this.pc = null;
    this.channels = new Map();
    this.remoteStream = new MediaStream();
    this.localStream = null;
    this.closed = false;
    this.connectPromise = null;
    this.signalQueue = [];
    this.pendingCandidates = [];
    this.negotiationPending = false;
    this.negotiationRunning = false;
    this.statsPrevious = null;
    this.signalingMode = "wss-room-relay";
    this.usingLocalSignaling = Boolean(signalingUrl && /^wss?:\/\//i.test(signalingUrl));
  }

  on(name, fn) {
    if (!EVENTS.includes(name)) throw new Error("Unsupported session event: " + name);
    this.addEventListener(name, (event) => fn(event.detail));
    return this;
  }

  emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }

  log(event, detail = {}) {
    this.onLog({ event, detail, at: new Date().toISOString() });
  }

  get inviteUrl() {
    const url = new URL(window.location.href);
    url.search = "";
    url.hash = "sessions";
    url.searchParams.set("code", this.code);
    if (this.signalingUrl) url.searchParams.set("signal", this.signalingUrl);
    return url.toString();
  }

  async connect() {
    if (this.closed) throw new Error("Session is already closed.");
    if (this.connectPromise) return this.connectPromise;

    if (!this.signalingUrl) {
      throw new Error("No WSS signaling server is configured.");
    }

    if (!/^wss?:\/\//i.test(this.signalingUrl)) {
      throw new Error("The signaling URL must use ws:// or wss://.");
    }

    this.connectPromise = new Promise((resolve, reject) => {
      let settled = false;
      let socket;

      try {
        socket = new WebSocket(this.signalingUrl);
      } catch (error) {
        reject(new Error("Could not create the signaling WebSocket: " + error.message));
        return;
      }

      this.signalingSocket = socket;
      this.emit("signaling", { state: "connecting", mode: this.signalingMode });

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };

      socket.onopen = () => {
        try {
          this.flushQueuedSignals();
          this.sendSignal({
            announce: true,
            from: this.peerId,
            role: this.role
          }, null, true);

          this.emit("signaling", {
            state: "connected",
            mode: this.signalingMode,
            peerId: this.peerId
          });
          this.emit("state", this.role === "host" ? "waiting" : "joining");
          this.log("signaling_ready", {
            mode: this.signalingMode
          });
          finish(resolve);
        } catch (error) {
          finish(reject, error);
        }
      };

      socket.onmessage = (event) => {
        if (typeof event.data !== "string" || event.data.length > MAX_SIGNAL_BYTES) {
          this.emit("error", {
            code: "SIGNAL_TOO_LARGE",
            message: "The signaling service sent an oversized message."
          });
          return;
        }

        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          this.emit("error", {
            code: "SIGNAL_PARSE_FAILED",
            message: "The signaling service sent invalid JSON."
          });
          return;
        }

        this.handleSignal(message).catch((error) => {
          this.emit("error", {
            code: "SIGNALING_HANDSHAKE_FAILED",
            message: error.message
          });
        });
      };

      socket.onerror = () => {
        const error = {
          code: "SIGNALING_UNAVAILABLE",
          message: "The configured signaling service could not be reached."
        };
        this.emit("error", error);
        finish(reject, new Error(error.message));
      };

      socket.onclose = () => {
        if (!this.closed) {
          this.emit("signaling", {
            state: "disconnected",
            mode: this.signalingMode
          });
          if (this.pc) this.emit("state", "disconnected");
        }
      };
    });

    return this.connectPromise;
  }

  flushQueuedSignals() {
    if (this.signalingSocket?.readyState !== WebSocket.OPEN) return;
    const queued = this.signalQueue.splice(0);
    for (const payload of queued) {
      try { this.signalingSocket.send(payload); } catch {
        this.signalQueue.unshift(payload);
        break;
      }
    }
  }

  sendSignal(payload, to = this.remotePeerId, queueWhenClosed = false) {
    if (this.closed) return false;

    const message = {
      roomId: this.code,
      from: this.peerId,
      to: to || null,
      sentAt: Date.now(),
      ...payload
    };

    const encoded = JSON.stringify(message);
    if (encoded.length > MAX_SIGNAL_BYTES) {
      this.emit("error", {
        code: "SIGNAL_TOO_LARGE",
        message: "Signaling message is too large."
      });
      return false;
    }

    if (this.signalingSocket?.readyState !== WebSocket.OPEN) {
      if (queueWhenClosed && this.signalQueue.length < 32) {
        this.signalQueue.push(encoded);
        return true;
      }
      return false;
    }

    try {
      this.signalingSocket.send(encoded);
      return true;
    } catch (error) {
      this.emit("error", {
        code: "SIGNAL_SEND_FAILED",
        message: error.message
      });
      return false;
    }
  }

  async handleSignal(message) {
    if (this.closed || !message || typeof message !== "object") return;
    if (message.roomId !== this.code) return;
    if (message.from === this.peerId) return;
    if (message.to && message.to !== this.peerId) return;

    const messageTimestamp = Number(message.sentAt);
    if (Number.isFinite(messageTimestamp) && Math.abs(Date.now() - messageTimestamp) > 120000) {
      this.log("stale_signal_rejected", {});
      return;
    }

    if (message.announce) {
      const role = message.role === "host" || message.role === "controller"
        ? message.role
        : "";

      if (!role || !message.from) return;

      if (this.role === "host" && role === "controller") {
        if (this.remotePeerId && this.remotePeerId !== message.from) {
          this.sendSignal({
            kind: "error",
            codeName: "SESSION_BUSY",
            message: "This session already has an active controller."
          }, message.from);
          return;
        }

        this.remotePeerId = message.from;
        this.remoteRole = role;
        this.emit("message", {
          channel: "system",
          data: JSON.stringify({ type: "peer_joined", peerId: message.from })
        });
        await this.ensurePeerConnection(true);
        return;
      }

      if (this.role === "controller" && role === "host") {
        this.remotePeerId = message.from;
        this.remoteRole = role;
        this.emit("message", {
          channel: "system",
          data: JSON.stringify({ type: "peer_joined", peerId: message.from })
        });
        await this.ensurePeerConnection(false);
        return;
      }

      return;
    }

    if (message.kind === "offer" && this.role === "controller") {
      if (this.remotePeerId && this.remotePeerId !== message.from) return;
      if (!message.description?.sdp) return;

      this.remotePeerId = message.from;
      await this.ensurePeerConnection(false);
      await this.pc.setRemoteDescription(message.description);
      await this.flushCandidates();

      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);

      this.sendSignal({
        kind: "answer",
        description: {
          type: this.pc.localDescription.type,
          sdp: this.pc.localDescription.sdp
        }
      }, this.remotePeerId);

      this.log("answer_sent", {});
      return;
    }

    if (message.kind === "answer" && this.role === "host") {
      if (!this.pc || this.remotePeerId !== message.from || !message.description?.sdp) return;
      await this.pc.setRemoteDescription(message.description);
      await this.flushCandidates();
      this.log("answer_received", {});
      return;
    }

    if (message.kind === "candidate") {
      if (!message.candidate) return;
      if (this.remotePeerId && this.remotePeerId !== message.from) return;
      this.remotePeerId = message.from;

      if (!this.pc || !this.pc.remoteDescription) {
        if (this.pendingCandidates.length < MAX_PENDING_CANDIDATES) {
          this.pendingCandidates.push(message.candidate);
        }
      } else {
        try {
          await this.pc.addIceCandidate(message.candidate);
        } catch (error) {
          this.log("candidate_rejected", { reason: error.message });
        }
      }
      return;
    }

    if (message.kind === "leave" || message.kind === "error") {
      if (message.from !== this.remotePeerId) return;
      if (message.kind === "error") {
        this.emit("error", {
          code: message.codeName || "SIGNALING_REMOTE_ERROR",
          message: message.message || "The signaling server rejected the session."
        });
        return;
      }

      this.remotePeerId = "";
      this.remoteRole = "";
      this.closePeerConnection();
      this.emit("message", {
        channel: "system",
        data: JSON.stringify({ type: "peer_left" })
      });
      this.emit("state", "disconnected");
    }
  }

  async ensurePeerConnection(shouldOffer = false) {
    if (this.pc) {
      if (shouldOffer && this.role === "host") {
        await this.negotiate();
      }
      return this.pc;
    }

    if (typeof RTCPeerConnection !== "function") {
      throw new Error("This browser does not support WebRTC.");
    }

    this.pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      iceCandidatePoolSize: 4
    });

    this.pc.onicecandidate = (event) => {
      if (!event.candidate || !this.remotePeerId) return;

      const candidate = typeof event.candidate.toJSON === "function"
        ? event.candidate.toJSON()
        : {
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
            usernameFragment: event.candidate.usernameFragment
          };

      this.sendSignal({
        kind: "candidate",
        candidate
      }, this.remotePeerId);
    };

    this.pc.onconnectionstatechange = () => {
      const value = this.pc?.connectionState || "closed";
      this.emit("state", value);
      this.log("connection_state", { state: value });

      if (value === "failed") {
        this.emit("error", {
          code: "WEBRTC_FAILED",
          message: "WebRTC could not establish a peer connection. A TURN server may be required on restrictive networks."
        });
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      this.emit("ice", this.pc?.iceConnectionState || "closed");
    };

    this.pc.onsignalingstatechange = () => {
      this.emit("signaling", {
        state: this.pc?.signalingState || "closed",
        mode: this.signalingMode
      });
    };

    this.pc.ondatachannel = (event) => this.attachChannel(event.channel);

    this.pc.ontrack = (event) => {
      const streams = event.streams?.length ? event.streams : [this.remoteStream];
      if (event.streams?.[0]) {
        this.remoteStream = event.streams[0];
      } else if (event.track && !this.remoteStream.getTracks().includes(event.track)) {
        this.remoteStream.addTrack(event.track);
      }
      this.emit("track", {
        stream: streams[0],
        track: event.track
      });
    };

    this.pc.onnegotiationneeded = () => {
      if (this.role === "host" && this.remotePeerId) {
        this.negotiationPending = true;
        this.negotiate().catch((error) => {
          this.emit("error", {
            code: "NEGOTIATION_FAILED",
            message: error.message
          });
        });
      }
    };

    if (this.role === "host") {
      CHANNELS.forEach((name) => {
        if (!this.channels.has(name)) {
          this.attachChannel(this.pc.createDataChannel(name, {
            ordered: name !== "input"
          }));
        }
      });

      if (this.localStream) {
        for (const track of this.localStream.getTracks()) {
          if (!this.pc.getSenders().some((sender) => sender.track?.kind === track.kind)) {
            this.pc.addTrack(track, this.localStream);
          }
        }
      }

      if (shouldOffer) await this.negotiate();
    }

    return this.pc;
  }

  attachChannel(channel) {
    if (!CHANNELS.includes(channel.label)) {
      try { channel.close(); } catch {}
      return;
    }

    const old = this.channels.get(channel.label);
    if (old && old !== channel) {
      try { old.close(); } catch {}
    }

    this.channels.set(channel.label, channel);
    channel.bufferedAmountLowThreshold = 64 * 1024;

    channel.onopen = () => {
      this.emit("channel", { name: channel.label, state: "open" });
      this.log("channel_open", { channel: channel.label });
    };

    channel.onclose = () => {
      if (this.channels.get(channel.label) === channel) this.channels.delete(channel.label);
      this.emit("channel", { name: channel.label, state: "closed" });
    };

    channel.onerror = () => {
      this.emit("error", {
        code: "CHANNEL_ERROR",
        message: channel.label + " channel error"
      });
    };

    channel.onmessage = (event) => {
      if (typeof event.data !== "string") {
        this.emit("error", {
          code: "INVALID_CHANNEL_MESSAGE",
          message: "Binary data is not valid for this logical channel."
        });
        return;
      }

      if (!validateDataChannelMessage(channel.label, event.data)) {
        this.emit("error", {
          code: "INVALID_CHANNEL_MESSAGE",
          message: "A malformed " + channel.label + " message was rejected."
        });
        return;
      }

      let data;
      try { data = JSON.parse(event.data); } catch { return; }

      this.emit("message", {
        channel: channel.label,
        data
      });
    };
  }

  async setLocalStream(stream) {
    if (this.role !== "host") throw new Error("Only the host can share a screen.");
    this.localStream = stream || null;

    if (!stream) {
      await this.clearLocalVideo();
      return;
    }

    if (!this.pc || !this.remotePeerId) return;

    let changed = false;

    for (const track of stream.getTracks()) {
      const sender = this.pc.getSenders().find(
        (candidate) => candidate.track?.kind === track.kind
      );

      if (sender) {
        await sender.replaceTrack(track);
      } else {
        this.pc.addTrack(track, stream);
        changed = true;
      }
    }

    if (changed) {
      await this.negotiate();
    }
  }

  async clearLocalVideo() {
    if (!this.pc) return;

    let changed = false;
    for (const sender of this.pc.getSenders()) {
      if (sender.track?.kind === "video") {
        await sender.replaceTrack(null);
        changed = true;
      }
    }

    this.localStream = null;

    if (changed && this.remotePeerId) {
      await this.negotiate();
    }

    this.emit("message", {
      channel: "system",
      data: JSON.stringify({ type: "screen_stopped" })
    });
  }

  async negotiate() {
    if (this.closed || this.role !== "host" || !this.pc || !this.remotePeerId) return;
    if (this.negotiationRunning) return;

    this.negotiationRunning = true;

    try {
      if (this.pc.signalingState !== "stable") {
        this.negotiationPending = true;
        return;
      }

      this.negotiationPending = false;

      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      if (!this.pc.localDescription) {
        throw new Error("The browser did not produce a local SDP offer.");
      }

      this.sendSignal({
        kind: "offer",
        description: {
          type: this.pc.localDescription.type,
          sdp: this.pc.localDescription.sdp
        }
      }, this.remotePeerId);

      this.log("offer_sent", {
        hasVideo: this.pc.getSenders().some((sender) => sender.track?.kind === "video")
      });
    } finally {
      this.negotiationRunning = false;
    }
  }

  send(channel, message) {
    if (this.closed || !CHANNELS.includes(channel)) return false;

    const payload = typeof message === "string" ? message : JSON.stringify(message);
    if (payload.length > 256 * 1024) return false;

    const target = this.channels.get(channel);

    if (!target || target.readyState === "connecting") {
      const queue = this.pendingMessages.get(channel) || [];
      if (queue.length >= MAX_PENDING_MESSAGES) queue.shift();
      queue.push(payload);
      this.pendingMessages.set(channel, queue);
      return true;
    }

    if (target.readyState !== "open" || target.bufferedAmount > 256 * 1024) {
      return false;
    }

    try {
      target.send(payload);
      return true;
    } catch (error) {
      this.emit("error", {
        code: "CHANNEL_SEND_FAILED",
        message: error.message
      });
      return false;
    }
  }

  flushCandidates() {
    if (!this.pc?.remoteDescription) return Promise.resolve();
    const candidates = this.pendingCandidates.splice(0);
    return candidates.reduce(
      (promise, candidate) => promise.then(async () => {
        try { await this.pc.addIceCandidate(candidate); }
        catch (error) { this.log("candidate_rejected", { reason: error.message }); }
      }),
      Promise.resolve()
    );
  }

  async getStats() {
    if (!this.pc || this.pc.connectionState === "closed") return null;
    if (typeof this.pc.getStats !== "function") return null;

    const reports = await this.pc.getStats();
    const result = { rtt: null, bitrate: null, fps: null, route: "unknown" };

    let selectedPair = null;

    reports.forEach((stat) => {
      if (stat.type === "transport" && stat.selectedCandidatePairId) {
        selectedPair = reports.get(stat.selectedCandidatePairId) || null;
      }
      if (!selectedPair &&
          stat.type === "candidate-pair" &&
          stat.state === "succeeded" &&
          (stat.selected || stat.nominated)) {
        selectedPair = stat;
      }
    });

    if (selectedPair) {
      result.rtt = selectedPair.currentRoundTripTime != null
        ? Math.round(selectedPair.currentRoundTripTime * 1000)
        : null;

      const local = selectedPair.localCandidateId
        ? reports.get(selectedPair.localCandidateId)
        : null;

      result.route = local?.candidateType === "relay"
        ? "relay"
        : (local?.candidateType || "direct");
    }

    const video = [...reports.values()].find(
      (stat) => stat.type === "inbound-rtp" &&
        (stat.kind === "video" || stat.mediaType === "video")
    );

    if (video) {
      const now = Date.now();
      result.fps = video.framesPerSecond ? Math.round(video.framesPerSecond) : null;
      result.bitrate = calculateBitrate(
        this.statsPrevious,
        { bytes: Number(video.bytesReceived || 0) },
        now
      );
      this.statsPrevious = {
        bytes: Number(video.bytesReceived || 0),
        at: now
      };
    }

    this.emit("stats", result);
    return result;
  }

  closePeerConnection() {
    this.channels.forEach((channel) => {
      try { channel.close(); } catch {}
    });
    this.channels.clear();

    try { this.pc?.close(); } catch {}
    this.pc = null;

    this.pendingCandidates = [];
    this.pendingMessages.clear();
    this.negotiationPending = false;
    this.negotiationRunning = false;
    this.statsPrevious = null;

    this.remoteStream.getTracks().forEach((track) => {
      try { track.stop(); } catch {}
    });
    this.remoteStream = new MediaStream();
  }

  close() {
    if (this.closed) return;

    this.closed = true;

    if (this.remotePeerId) {
      this.sendSignal({
        kind: "leave"
      }, this.remotePeerId, false);
    }

    this.closePeerConnection();

    try { this.signalingSocket?.close(); } catch {}
    this.signalingSocket = null;

    this.emit("state", "closed");
  }
}
