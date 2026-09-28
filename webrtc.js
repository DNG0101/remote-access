import {
  CHANNELS,
  makePeerId,
  validateDataChannelMessage,
  validateSignalMessage,
  calculateBitrate,
  MAX_PENDING_CANDIDATES,
  MAX_PENDING_MESSAGES
} from "./protocol.js";

const EVENTS = ["state", "ice", "signaling", "channel", "track", "stats", "message", "error"];

export class PeerSession extends EventTarget {
  constructor({ code, role, iceServers = [], onLog = () => {} }) {
    super();
    this.code = code;
    this.role = role;
    this.peerId = makePeerId();
    this.onLog = onLog;
    this.iceServers = Array.isArray(iceServers) ? iceServers : [];
    this.pc = null;
    this.channels = new Map();
    this.remoteStream = new MediaStream();
    this.localStream = null;
    this.room = null;
    this.signalingSocket = null;
    this.signalingReadyPromise = null;
    this.remotePeerId = null;
    this.pendingCandidates = [];
    this.pendingMessages = new Map();
    this.negotiationPromise = null;
    this.closed = false;
    this.statsPrevious = null;
    this.signalingMode = "";
    this.usingLocalSignaling = false;
  }

  on(name, fn) {
    if (!EVENTS.includes(name)) throw new Error("Unsupported session event: " + name);
    this.addEventListener(name, (event) => fn(event.detail));
    return this;
  }

  emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }

  makeEnvelope(payload, to = this.remotePeerId) {
    return {
      ...payload,
      code: this.code,
      from: this.role,
      peerId: this.peerId,
      to: to || null,
      at: Date.now()
    };
  }

  signal(payload, to = this.remotePeerId) {
    if (this.closed) return false;
    const message = this.makeEnvelope(payload, to);
    const result = validateSignalMessage(message);

    if (!result.ok) {
      this.emit("error", {
        code: result.reason,
        message: "Invalid signaling message was blocked."
      });
      return false;
    }

    if (this.room) {
      this.room.postMessage(message);
      return true;
    }

    if (this.signalingSocket?.readyState === WebSocket.OPEN) {
      this.signalingSocket.send(JSON.stringify(message));
      return true;
    }

    return false;
  }

  openRoom() {
    if (this.room || this.signalingSocket) return;

    const configuredUrl = globalThis.window?.P2P_DESK_CONFIG?.signalingUrl?.trim?.() || "";
    const BroadcastChannelCtor = globalThis.window?.BroadcastChannel || globalThis.BroadcastChannel;

    if (configuredUrl) {
      this.signalingMode = "websocket";
      this.usingLocalSignaling = false;
      return;
    }

    if (typeof BroadcastChannelCtor === "function") {
      this.room = new BroadcastChannelCtor("p2p-desk:" + this.code);
      this.usingLocalSignaling = true;
      this.signalingMode = "same-origin-tabs";
      this.room.onmessage = (event) => {
        this.handleSignal(event.data).catch((error) => {
          this.emit("error", {
            code: "SIGNALING_HANDSHAKE_FAILED",
            message: error.message
          });
        });
      };
      return;
    }

    throw new Error(
      "No signaling transport is configured. Same-device mode needs BroadcastChannel; cross-device mode needs a WSS signalingUrl."
    );
  }

  async connect() {
    if (this.closed) throw new Error("Session is closed.");

    this.openRoom();
    this.emit("signaling", {
      state: "connecting",
      mode: this.signalingMode
    });

    const configuredUrl = globalThis.window?.P2P_DESK_CONFIG?.signalingUrl?.trim?.() || "";
    if (configuredUrl) {
      await this.connectWebSocket(configuredUrl);
    }

    if (this.role === "controller") {
      if (!this.signal({ type: "join", role: "controller" }, null)) {
        throw new Error(
          "The session signaling transport is not ready. For two devices, configure a public WSS signaling endpoint."
        );
      }
      this.emit("state", "joining");
    } else {
      this.emit("state", "waiting");
    }

    this.emit("signaling", {
      state: "connected",
      mode: this.signalingMode
    });

    this.log("signaling_ready", {
      mode: this.signalingMode
    });
  }

  connectWebSocket(url) {
    if (this.signalingReadyPromise) return this.signalingReadyPromise;

    this.signalingReadyPromise = new Promise((resolve, reject) => {
      let settled = false;
      let socket;

      try {
        socket = new WebSocket(url);
      } catch {
        reject(new Error("The configured signaling URL is invalid."));
        return;
      }

      this.signalingSocket = socket;

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { socket.close(); } catch {}
        reject(new Error("The signaling service did not become ready within 8 seconds."));
      }, 8000);

      socket.onopen = () => {
        if (settled) return;
        clearTimeout(timeout);
        settled = true;

        // Send join only after WebSocket is actually open.
        if (!this.signal({ type: "join", role: this.role }, null)) {
          reject(new Error("The signaling connection opened but the join message could not be sent."));
          return;
        }

        resolve();
      };

      socket.onmessage = (event) => {
        if (typeof event.data !== "string" || event.data.length > 300000) {
          this.emit("error", {
            code: "SIGNAL_TOO_LARGE",
            message: "The signaling service sent an oversized message."
          });
          return;
        }

        try {
          const message = JSON.parse(event.data);
          this.handleSignal(message).catch((error) => {
            this.emit("error", {
              code: "SIGNALING_HANDSHAKE_FAILED",
              message: error.message
            });
          });
        } catch {
          this.emit("error", {
            code: "SIGNAL_PARSE_FAILED",
            message: "The signaling service sent invalid JSON."
          });
        }
      };

      socket.onerror = () => {
        const error = {
          code: "SIGNALING_UNAVAILABLE",
          message: "The configured signaling service could not be reached."
        };
        this.emit("error", error);

        if (!settled) {
          clearTimeout(timeout);
          settled = true;
          reject(new Error(error.message));
        }
      };

      socket.onclose = () => {
        if (!this.closed) {
          this.emit("signaling", {
            state: "disconnected",
            mode: "websocket"
          });
        }
      };
    });

    return this.signalingReadyPromise;
  }

  createPeer() {
    if (this.pc) return this.pc;

    if (typeof RTCPeerConnection !== "function") {
      throw new Error("This browser does not support WebRTC peer connections.");
    }

    this.pc = new RTCPeerConnection({
      iceServers: this.iceServers
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

      this.signal(
        {
          type: "candidate",
          candidate
        },
        this.remotePeerId
      );
    };

    this.pc.onconnectionstatechange = () => {
      const value = this.pc?.connectionState || "closed";
      this.emit("state", value);
      this.log("connection_state", { state: value });
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

    this.pc.ontrack = (event) => {
      const tracks = event.streams?.[0]?.getTracks?.() || [event.track];
      for (const track of tracks) {
        if (track && !this.remoteStream.getTracks().includes(track)) {
          this.remoteStream.addTrack(track);
        }
      }

      this.emit("track", {
        stream: this.remoteStream,
        track: event.track
      });
    };

    this.pc.ondatachannel = (event) => this.attachChannel(event.channel);

    return this.pc;
  }

  createChannels() {
    if (!this.pc || this.role !== "host") return;

    CHANNELS.forEach((name) => {
      if (!this.channels.has(name)) {
        this.attachChannel(
          this.pc.createDataChannel(name, {
            ordered: name !== "input"
          })
        );
      }
    });
  }

  attachChannel(channel) {
    if (!CHANNELS.includes(channel.label)) {
      try { channel.close(); } catch {}
      this.emit("error", {
        code: "CHANNEL_UNSUPPORTED",
        message: "Unsupported data channel was closed."
      });
      return;
    }

    const previous = this.channels.get(channel.label);
    if (previous && previous !== channel) {
      try { previous.close(); } catch {}
    }

    this.channels.set(channel.label, channel);
    channel.bufferedAmountLowThreshold = 64 * 1024;

    channel.onopen = () => {
      const queued = this.pendingMessages.get(channel.label) || [];
      this.pendingMessages.delete(channel.label);

      for (const message of queued) {
        if (channel.readyState !== "open") break;
        if (channel.bufferedAmount > 256 * 1024) break;
        channel.send(message);
      }

      this.emit("channel", {
        name: channel.label,
        state: "open"
      });
      this.log("channel_open", {
        channel: channel.label
      });
    };

    channel.onclose = () => {
      if (this.channels.get(channel.label) === channel) {
        this.channels.delete(channel.label);
      }
      this.emit("channel", {
        name: channel.label,
        state: "closed"
      });
    };

    channel.onerror = () => {
      this.emit("error", {
        code: "CHANNEL_ERROR",
        message: channel.label + " channel error"
      });
    };

    channel.onmessage = (event) => {
      if (typeof event.data === "string" &&
          !validateDataChannelMessage(channel.label, event.data)) {
        this.emit("error", {
          code: "INVALID_CHANNEL_MESSAGE",
          message: "A malformed " + channel.label + " message was rejected."
        });
        return;
      }

      this.emit("message", {
        channel: channel.label,
        data: event.data
      });
    };
  }

  async setLocalStream(stream) {
    this.localStream = stream || null;

    if (!stream) {
      await this.clearLocalVideo();
      return;
    }

    if (!this.pc) {
      // Persist stream; it will be attached when the host creates the peer.
      return;
    }

    let needsNegotiation = false;

    for (const track of stream.getTracks()) {
      const sender = this.pc.getSenders().find(
        (candidate) => candidate.track?.kind === track.kind
      );

      if (sender) {
        await sender.replaceTrack(track);
      } else {
        this.pc.addTrack(track, stream);
        needsNegotiation = true;
      }
    }

    if (needsNegotiation && this.role === "host" && this.remotePeerId) {
      await this.negotiate();
    }
  }

  async clearLocalVideo() {
    if (!this.pc) {
      return;
    }

    let changed = false;

    for (const sender of this.pc.getSenders()) {
      if (sender.track?.kind === "video") {
        await sender.replaceTrack(null);
        changed = true;
      }
    }

    if (changed && this.remotePeerId && this.role === "host") {
      await this.negotiate();
    }
  }

  async startHostConnection() {
    if (this.role !== "host") return;
    if (!this.remotePeerId) throw new Error("No controller has joined.");
    const pc = this.createPeer();

    this.createChannels();

    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        if (!pc.getSenders().some((sender) => sender.track?.kind === track.kind)) {
          pc.addTrack(track, this.localStream);
        }
      }
    }

    await this.negotiate();
  }

  async negotiate() {
    if (this.closed || this.role !== "host" || !this.pc || !this.remotePeerId) {
      return;
    }

    if (this.negotiationPromise) return this.negotiationPromise;

    this.negotiationPromise = (async () => {
      if (this.pc.signalingState !== "stable") return;

      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      if (!this.pc.localDescription) {
        throw new Error("The browser did not produce a local WebRTC offer.");
      }

      this.signal(
        {
          type: "offer",
          description: {
            type: this.pc.localDescription.type,
            sdp: this.pc.localDescription.sdp
          }
        },
        this.remotePeerId
      );

      this.log("offer_sent", {});
    })().finally(() => {
      this.negotiationPromise = null;
    });

    return this.negotiationPromise;
  }

  async handleSignal(message) {
    if (this.closed || !message) return;

    const validation = validateSignalMessage(message);
    if (!validation.ok) {
      this.log("invalid_signal", {
        reason: validation.reason
      });
      return;
    }

    if (message.code !== this.code) return;
    if (message.peerId === this.peerId) return;
    if (message.to && message.to !== this.peerId) return;

    if (message.type === "join") {
      if (this.role !== "host" || message.role !== "controller") return;

      if (this.remotePeerId && this.remotePeerId !== message.peerId) {
        this.signal(
          {
            type: "reject",
            codeName: "SESSION_BUSY",
            message: "This session already has an active controller."
          },
          message.peerId
        );
        return;
      }

      this.remotePeerId = message.peerId;
      this.emit("message", {
        channel: "system",
        data: JSON.stringify({
          type: "peer_joined"
        })
      });

      this.signal(
        {
          type: "join_ack"
        },
        this.remotePeerId
      );

      // IMPORTANT: connect view-only immediately. Consent belongs to control, not transport.
      await this.startHostConnection();
      return;
    }

    if (message.type === "join_ack") {
      if (this.role === "controller" && message.from === "host") {
        this.remotePeerId = message.peerId;
        this.emit("message", {
          channel: "system",
          data: JSON.stringify({
            type: "peer_join_ack"
          })
        });
        this.log("peer_join_ack", {
          peerId: message.peerId
        });
      }
      return;
    }

    if (message.from === this.role) return;

    try {
      if (message.type === "offer" && this.role === "controller") {
        if (this.remotePeerId && this.remotePeerId !== message.peerId) return;

        this.remotePeerId = message.peerId;
        const pc = this.createPeer();

        await pc.setRemoteDescription(message.description);
        await this.flushCandidates();

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        if (!pc.localDescription) {
          throw new Error("The browser did not produce a local WebRTC answer.");
        }

        this.signal(
          {
            type: "answer",
            description: {
              type: pc.localDescription.type,
              sdp: pc.localDescription.sdp
            }
          },
          this.remotePeerId
        );

        this.log("answer_sent", {});
        return;
      }

      if (message.type === "answer" && this.role === "host" && this.pc) {
        if (this.remotePeerId !== message.peerId) return;

        await this.pc.setRemoteDescription(message.description);
        await this.flushCandidates();
        this.log("answer_received", {});
        return;
      }

      if (message.type === "candidate") {
        if (this.remotePeerId && this.remotePeerId !== message.peerId) return;

        this.remotePeerId = message.peerId;

        if (!this.pc || !this.pc.remoteDescription) {
          if (this.pendingCandidates.length < MAX_PENDING_CANDIDATES) {
            this.pendingCandidates.push(message.candidate);
          }
        } else {
          try {
            await this.pc.addIceCandidate(message.candidate);
          } catch (error) {
            this.log("candidate_rejected", {
              reason: error.message
            });
          }
        }
        return;
      }

      if (message.type === "reject" || message.type === "error") {
        this.emit("error", {
          code: message.codeName || "SIGNALING_REJECTED",
          message: message.message || "The signaling service rejected this session."
        });
        return;
      }

      if (message.type === "leave") {
        this.emit("message", {
          channel: "system",
          data: JSON.stringify({
            type: "peer_left"
          })
        });
        this.remotePeerId = null;
        this.closePeerConnection();
      }
    } catch (error) {
      this.emit("error", {
        code: "SIGNALING_HANDSHAKE_FAILED",
        message: error.message
      });
      this.log("handshake_error", {
        reason: error.message
      });
    }
  }

  async flushCandidates() {
    if (!this.pc?.remoteDescription) return;

    const candidates = this.pendingCandidates.splice(0);
    for (const candidate of candidates) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch (error) {
        this.log("candidate_rejected", {
          reason: error.message
        });
      }
    }
  }

  send(channel, message) {
    if (!CHANNELS.includes(channel) || this.closed) return false;

    const payload = typeof message === "string"
      ? message
      : JSON.stringify(message);

    if (typeof payload !== "string" || payload.length > 256 * 1024) {
      return false;
    }

    const target = this.channels.get(channel);

    if (!target || target.readyState === "connecting") {
      const queue = this.pendingMessages.get(channel) || [];
      if (queue.length >= MAX_PENDING_MESSAGES) queue.shift();
      queue.push(payload);
      this.pendingMessages.set(channel, queue);
      return true;
    }

    if (target.readyState !== "open") return false;
    if (target.bufferedAmount > 256 * 1024) return false;

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

  async getStats() {
    if (!this.pc || this.pc.connectionState === "closed") return null;

    const reports = await this.pc.getStats();
    const result = {
      rtt: null,
      bitrate: null,
      fps: null,
      route: "unknown"
    };

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
      (stat) =>
        stat.type === "inbound-rtp" &&
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
    this.negotiationPromise = null;
    this.statsPrevious = null;

    this.remoteStream.getTracks().forEach((track) => {
      try { track.stop(); } catch {}
    });
    this.remoteStream = new MediaStream();
  }

  close() {
    if (this.closed) return;

    if (this.remotePeerId) {
      this.signal({ type: "leave" }, this.remotePeerId);
    }

    this.closed = true;
    this.closePeerConnection();

    try { this.room?.close(); } catch {}
    try { this.signalingSocket?.close(); } catch {}

    this.room = null;
    this.signalingSocket = null;
    this.emit("state", "closed");
  }

  log(event, detail) {
    this.onLog({
      event,
      detail,
      at: new Date().toISOString()
    });
  }
}
