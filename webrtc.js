import {
  CHANNELS,
  makePeerId,
  validateDataChannelMessage,
  calculateBitrate
} from "./protocol.js";

const EVENTS = ["state","ice","signaling","channel","track","stats","message","error"];

export class PeerSession extends EventTarget {
  constructor({ code, role, iceServers = [], targetPeerId = "", onLog = () => {} }) {
    super();
    this.code = code;
    this.role = role;
    this.peerId = makePeerId();
    this.targetPeerId = targetPeerId || "";
    this.onLog = onLog;
    this.iceServers = Array.isArray(iceServers) ? iceServers : [];
    this.peer = null;
    this.connection = null;
    this.mediaCall = null;
    this.localStream = null;
    this.remoteStream = new MediaStream();
    this.closed = false;
    this.openPromise = null;
    this.signalingMode = "peerjs-cloud";
    this.usingLocalSignaling = false;
    this.remotePeerId = "";
    this.statsPrevious = null;
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
    if (!this.peer?.id) return "";
    const url = new URL(window.location.href);
    url.hash = "sessions";
    url.search = "";
    url.searchParams.set("join", this.peer.id);
    url.searchParams.set("code", this.code);
    return url.toString();
  }

  async connect() {
    if (this.closed) throw new Error("Session is closed.");
    if (this.openPromise) return this.openPromise;

    const PeerCtor = globalThis.window?.Peer;
    if (typeof PeerCtor !== "function") {
      throw new Error("The P2P signaling library did not load. Refresh the page and try again.");
    }

    this.openPromise = new Promise((resolve, reject) => {
      let settled = false;

      const peerOptions = {
        debug: 1,
        config: {
          iceServers: this.iceServers
        }
      };

      try {
        this.peer = new PeerCtor(undefined, peerOptions);
      } catch (error) {
        reject(error);
        return;
      }

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };

      this.emit("signaling", {
        state: "connecting",
        mode: this.signalingMode
      });

      this.peer.on("open", (id) => {
        this.peerId = id;
        this.emit("signaling", {
          state: "connected",
          mode: this.signalingMode,
          peerId: id
        });
        this.log("signaling_ready", {
          mode: this.signalingMode
        });

        if (this.role === "host") {
          this.emit("state", "waiting");
          finish(resolve);
          return;
        }

        if (!this.targetPeerId) {
          finish(reject, new Error(
            "A cross-device join link is required. Open the host's invite link, or use two tabs on the same device."
          ));
          return;
        }

        this.connectToHost();
        finish(resolve);
      });

      this.peer.on("connection", (connection) => {
        if (this.role !== "host") {
          try { connection.close(); } catch {}
          return;
        }
        this.attachConnection(connection);
      });

      this.peer.on("call", (call) => {
        if (this.role !== "controller") {
          try { call.close(); } catch {}
          return;
        }

        if (this.remotePeerId && call.peer !== this.remotePeerId) {
          try { call.close(); } catch {}
          return;
        }

        this.remotePeerId = call.peer;
        this.mediaCall = call;

        try {
          call.answer();
        } catch (error) {
          this.emit("error", {
            code: "MEDIA_ANSWER_FAILED",
            message: error.message
          });
          return;
        }

        call.on("stream", (stream) => {
          this.remoteStream.getTracks().forEach((track) => {
            try { track.stop(); } catch {}
          });
          this.remoteStream = stream;
          this.emit("track", {
            stream,
            track: stream.getVideoTracks?.()[0] || stream.getTracks?.()[0] || null
          });
        });

        call.on("close", () => {
          this.mediaCall = null;
        });

        call.on("error", (error) => {
          this.emit("error", {
            code: "MEDIA_CALL_FAILED",
            message: error.message || "Remote media call failed."
          });
        });
      });

      this.peer.on("disconnected", () => {
        this.emit("signaling", {
          state: "disconnected",
          mode: this.signalingMode
        });
      });

      this.peer.on("close", () => {
        if (!this.closed) this.emit("state", "closed");
      });

      this.peer.on("error", (error) => {
        const message = this.describePeerError(error);
        this.log("peer_error", { type: error?.type, message });
        this.emit("error", {
          code: "PEERJS_" + String(error?.type || "ERROR").toUpperCase().replaceAll("-", "_"),
          message
        });
        if (!settled) finish(reject, new Error(message));
      });
    });

    return this.openPromise;
  }

  describePeerError(error) {
    const type = error?.type;
    if (type === "peer-unavailable") {
      return "The host invite is no longer active. Ask the host to create a new session.";
    }
    if (type === "network") {
      return "The signaling service could not be reached. Check the network connection.";
    }
    if (type === "browser-incompatible") {
      return "This browser does not support the required WebRTC features.";
    }
    if (type === "invalid-id") {
      return "The host invite link is invalid.";
    }
    if (type === "unavailable-id") {
      return "This session ID is already in use. Create a new session.";
    }
    return error?.message || "The peer signaling connection failed.";
  }

  connectToHost() {
    if (!this.peer || !this.targetPeerId) return;

    this.emit("state", "connecting");
    this.remotePeerId = this.targetPeerId;

    let connection;
    try {
      connection = this.peer.connect(this.targetPeerId, {
        reliable: true,
        metadata: {
          role: "controller",
          code: this.code
        }
      });
    } catch (error) {
      this.emit("error", {
        code: "DATA_CONNECT_FAILED",
        message: error.message
      });
      return;
    }

    this.attachConnection(connection);
  }

  attachConnection(connection) {
    if (!connection) return;

    if (this.connection && this.connection !== connection) {
      try { this.connection.close(); } catch {}
    }

    if (this.remotePeerId && connection.peer !== this.remotePeerId) {
      try { connection.close(); } catch {}
      return;
    }

    this.connection = connection;
    this.remotePeerId = connection.peer;

    connection.on("open", async () => {
      this.emit("state", "connected");
      this.log("peer_connected", {
        peerId: connection.peer
      });

      this.emit("message", {
        channel: "system",
        data: JSON.stringify({
          type: "peer_joined",
          peerId: connection.peer
        })
      });

      if (this.role === "host" && this.localStream) {
        await this.sendScreen();
      }
    });

    connection.on("data", (payload) => this.handleData(payload));

    connection.on("close", () => {
      this.emit("message", {
        channel: "system",
        data: JSON.stringify({
          type: "peer_left"
        })
      });
      this.emit("state", "disconnected");
      if (this.connection === connection) this.connection = null;
      this.remotePeerId = "";
    });

    connection.on("error", (error) => {
      this.emit("error", {
        code: "DATA_CONNECTION_FAILED",
        message: error.message || "Peer data connection failed."
      });
    });

    // PeerJS can queue the outbound connection before "open".
    this.log("data_connection_created", {
      peerId: connection.peer
    });
  }

  handleData(payload) {
    let envelope = payload;
    if (typeof payload === "string") {
      try { envelope = JSON.parse(payload); } catch {
        this.emit("error", {
          code: "INVALID_CHANNEL_MESSAGE",
          message: "Malformed peer message was rejected."
        });
        return;
      }
    }

    if (!envelope || typeof envelope !== "object") return;

    const channel = envelope.channel;
    const data = envelope.data;

    if (!CHANNELS.includes(channel) && channel !== "system") {
      this.emit("error", {
        code: "CHANNEL_UNSUPPORTED",
        message: "Unsupported data channel was rejected."
      });
      return;
    }

    if (channel !== "system") {
      const serialized = typeof data === "string" ? data : JSON.stringify(data);
      if (!validateDataChannelMessage(channel, serialized)) {
        this.emit("error", {
          code: "INVALID_CHANNEL_MESSAGE",
          message: "A malformed " + channel + " message was rejected."
        });
        return;
      }
    }

    this.emit("message", {
      channel,
      data
    });
  }

  send(channel, message) {
    if (this.closed || !this.connection || this.connection.open !== true) return false;
    if (!CHANNELS.includes(channel)) return false;

    const data = typeof message === "string" ? message : JSON.stringify(message);
    const envelope = {
      channel,
      data
    };

    try {
      this.connection.send(envelope);
      return true;
    } catch (error) {
      this.emit("error", {
        code: "CHANNEL_SEND_FAILED",
        message: error.message
      });
      return false;
    }
  }

  async setLocalStream(stream) {
    this.localStream = stream || null;
    if (!stream) {
      if (this.mediaCall) {
        try { this.mediaCall.close(); } catch {}
        this.mediaCall = null;
      }
      return;
    }

    if (this.role === "host" && this.connection?.open) {
      await this.sendScreen();
    }
  }

  async sendScreen() {
    if (this.role !== "host" || !this.peer || !this.remotePeerId || !this.localStream) return;

    if (this.mediaCall) {
      try { this.mediaCall.close(); } catch {}
      this.mediaCall = null;
    }

    try {
      this.mediaCall = this.peer.call(
        this.remotePeerId,
        this.localStream,
        {
          metadata: {
            code: this.code,
            purpose: "screen"
          }
        }
      );

      this.mediaCall.on("error", (error) => {
        this.emit("error", {
          code: "MEDIA_CALL_FAILED",
          message: error.message || "Screen stream failed."
        });
      });

      this.log("screen_call_started", {
        peerId: this.remotePeerId
      });
    } catch (error) {
      this.emit("error", {
        code: "MEDIA_CALL_FAILED",
        message: error.message
      });
    }
  }

  async clearLocalVideo() {
    this.localStream = null;
    if (this.mediaCall) {
      try { this.mediaCall.close(); } catch {}
      this.mediaCall = null;
    }
    this.emit("message", {
      channel: "system",
      data: JSON.stringify({
        type: "screen_stopped"
      })
    });
  }

  async getStats() {
    const pc = this.connection?.peerConnection;
    if (!pc?.getStats) return null;

    const reports = await pc.getStats();
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

  close() {
    if (this.closed) return;
    this.closed = true;

    try { this.connection?.close(); } catch {}
    try { this.mediaCall?.close(); } catch {}
    try { this.peer?.destroy(); } catch {}

    this.connection = null;
    this.mediaCall = null;
    this.peer = null;
    this.emit("state", "closed");
  }
}
