import {
  CHANNELS,
  makePeerId,
  validateSignalMessage,
  validateDataChannelMessage,
  calculateBitrate,
  MAX_PENDING_CANDIDATES,
  MAX_PENDING_MESSAGES,
  MAX_SIGNAL_BYTES,
  MAX_CHANNEL_BYTES
} from "./protocol.js";

const EVENTS = [
  "state",
  "ice",
  "signaling",
  "channel",
  "track",
  "stats",
  "message",
  "error"
];

const SIGNAL_CONNECT_TIMEOUT_MS = 12_000;
const CLOSE_GRACE_MS = 250;
const PEER_ID_RE = /^[A-Za-z0-9_-]{8,96}$/;

export class PeerSession extends EventTarget {
  constructor({
    code,
    role,
    iceServers = [],
    signalingUrl = "",
    onLog = () => {}
  }) {
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
    this.pendingMessages = new Map();
    CHANNELS.forEach((name) => this.pendingMessages.set(name, []));

    this.remoteStream = new MediaStream();
    this.localStream = null;
    this.videoSender = null;

    this.closed = false;
    this.connectPromise = null;
    this.connectTimer = null;

    this.signalQueue = [];
    this.pendingCandidates = [];

    this.negotiationPending = false;
    this.negotiationRunning = false;

    this.statsPrevious = null;
    this.signalingMode = "wss-room-relay";
    this.usingLocalSignaling = Boolean(
      signalingUrl &&
      /^wss?:\/\//i.test(signalingUrl)
    );
  }

  on(name, fn) {
    if (!EVENTS.includes(name)) {
      throw new Error("Unsupported session event: " + name);
    }

    this.addEventListener(name, (event) => fn(event.detail));
    return this;
  }

  emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }

  log(event, detail = {}) {
    this.onLog({
      event,
      detail,
      at: new Date().toISOString()
    });
  }

  get inviteUrl() {
    const url = new URL(window.location.href);
    url.search = "";
    url.hash = "sessions";
    url.searchParams.set("code", this.code);

    if (this.signalingUrl) {
      url.searchParams.set("signal", this.signalingUrl);
    }

    return url.toString();
  }

  async connect() {
    if (this.closed) {
      throw new Error("Session is already closed.");
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    if (!this.signalingUrl) {
      throw new Error("No WSS signaling server is configured.");
    }

    if (!/^wss?:\/\//i.test(this.signalingUrl)) {
      throw new Error("The signaling URL must use ws:// or wss://.");
    }

    this.connectPromise = new Promise((resolve, reject) => {
      let settled = false;
      let socket;

      const cleanup = () => {
        if (this.connectTimer) {
          clearTimeout(this.connectTimer);
          this.connectTimer = null;
        }
      };

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value);
      };

      try {
        socket = new WebSocket(this.signalingUrl);
      } catch (error) {
        finish(
          reject,
          new Error(
            "Could not create the signaling WebSocket: " + error.message
          )
        );
        return;
      }

      this.signalingSocket = socket;
      this.emit("signaling", {
        state: "connecting",
        mode: this.signalingMode
      });

      this.connectTimer = setTimeout(() => {
        try { socket.close(); } catch {}
        const error = new Error(
          "Signaling connection timed out after 12 seconds."
        );
        this.emit("error", {
          code: "SIGNALING_TIMEOUT",
          message: error.message
        });
        finish(reject, error);
      }, SIGNAL_CONNECT_TIMEOUT_MS);

      socket.onopen = () => {
        try {
          this.sendSignal(
            {
              announce: true,
              role: this.role
            },
            null,
            false
          );

          this.flushQueuedSignals();

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
        if (
          typeof event.data !== "string" ||
          event.data.length > MAX_SIGNAL_BYTES
        ) {
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

        const validation = validateSignalMessage(message);
        if (!validation.ok) {
          this.log("invalid_signal_rejected", {
            reason: validation.reason
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
        const error = new Error(
          "The configured signaling service could not be reached."
        );

        this.emit("error", {
          code: "SIGNALING_UNAVAILABLE",
          message: error.message
        });
        finish(reject, error);
      };

      socket.onclose = () => {
        cleanup();

        if (!settled) {
          finish(
            reject,
            new Error("The signaling connection closed before it was ready.")
          );
        }

        if (!this.closed) {
          this.emit("signaling", {
            state: "disconnected",
            mode: this.signalingMode
          });

          if (this.pc && this.pc.connectionState !== "closed") {
            this.emit("state", "disconnected");
          }
        }
      };
    });

    return this.connectPromise;
  }

  flushQueuedSignals() {
    if (this.signalingSocket?.readyState !== WebSocket.OPEN) return;

    const queued = this.signalQueue.splice(0);
    for (const payload of queued) {
      try {
        this.signalingSocket.send(payload);
      } catch {
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

    const validation = validateSignalMessage(message);
    if (!validation.ok) {
      this.emit("error", {
        code: "SIGNAL_INVALID",
        message: "A local signaling message was rejected: " + validation.reason
      });
      return false;
    }

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

    if (
      message.sys === "roster" &&
      message.roomId === this.code &&
      Array.isArray(message.roster)
    ) {
      const previousPeerId = this.remotePeerId;
      const nextPeerId =
        message.roster.find(
          (peerId) =>
            peerId !== this.peerId &&
            PEER_ID_RE.test(peerId)
        ) || "";

      if (!nextPeerId) {
        if (previousPeerId) {
          this.remotePeerId = "";
          this.remoteRole = "";
          this.closePeerConnection();
          this.emit("message", {
            channel: "system",
            data: JSON.stringify({ type: "peer_left" })
          });
          this.emit("state", "disconnected");
        }
        return;
      }

      if (
        previousPeerId &&
        previousPeerId !== nextPeerId &&
        this.pc?.connectionState !== "closed"
      ) {
        return;
      }

      if (previousPeerId !== nextPeerId) {
        this.closePeerConnection();
        this.remotePeerId = nextPeerId;
        this.remoteRole =
          this.role === "host" ? "controller" : "host";

        this.emit("message", {
          channel: "system",
          data: JSON.stringify({
            type: "peer_joined",
            peerId: nextPeerId
          })
        });

        await this.ensurePeerConnection(this.role === "host");
      }
      return;
    }

    if (message.server === true && message.kind === "error") {
      this.emit("error", {
        code: message.codeName || "SIGNALING_SERVER_ERROR",
        message: message.message || "The signaling server rejected the session."
      });

      if (
        message.codeName === "SESSION_BUSY" ||
        message.codeName === "ROLE_CONFLICT" ||
        message.codeName === "NOT_JOINED" ||
        message.codeName === "SESSION_EXPIRED"
      ) {
        this.remotePeerId = "";
        this.remoteRole = "";
        this.closePeerConnection();
        this.emit("state", "failed");
      }
      return;
    }

    if (message.roomId !== this.code) return;
    if (message.from === this.peerId) return;
    if (message.to && message.to !== this.peerId) return;

    if (!Number.isFinite(Number(message.sentAt))) return;

    if (!Number.isFinite(Number(message.sentAt)) ||
        Math.abs(Date.now() - Number(message.sentAt)) > 120_000) {
      this.log("stale_signal_rejected", {});
      return;
    }

    if (message.announce === true) {
      const role = message.role;
      if (role !== "host" && role !== "controller") return;

      if (this.role === "host" && role === "controller") {
        if (
          this.remotePeerId &&
          this.remotePeerId !== message.from &&
          this.pc?.connectionState !== "closed"
        ) {
          this.sendSignal(
            {
              kind: "error",
              codeName: "SESSION_BUSY",
              message: "This session already has an active controller."
            },
            message.from
          );
          return;
        }

        this.closePeerConnection();
        this.remotePeerId = message.from;
        this.remoteRole = role;

        this.emit("message", {
          channel: "system",
          data: JSON.stringify({
            type: "peer_joined",
            peerId: message.from
          })
        });

        await this.ensurePeerConnection(true);
        return;
      }

      if (this.role === "controller" && role === "host") {
        if (
          this.remotePeerId &&
          this.remotePeerId !== message.from &&
          this.pc?.connectionState !== "closed"
        ) {
          return;
        }

        this.closePeerConnection();
        this.remotePeerId = message.from;
        this.remoteRole = role;

        this.emit("message", {
          channel: "system",
          data: JSON.stringify({
            type: "peer_joined",
            peerId: message.from
          })
        });

        await this.ensurePeerConnection(false);
        return;
      }

      return;
    }

    if (message.kind === "offer" && this.role === "controller") {
      if (
        this.remotePeerId &&
        this.remotePeerId !== message.from
      ) {
        return;
      }

      if (!message.description?.sdp) return;

      this.remotePeerId = message.from;
      await this.ensurePeerConnection(false);

      try {
        await this.pc.setRemoteDescription(message.description);
      } catch (error) {
        this.emit("error", {
          code: "REMOTE_OFFER_REJECTED",
          message: error.message
        });
        return;
      }

      await this.flushCandidates();

      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);

      const description = this.pc.localDescription;
      if (!description?.sdp) {
        throw new Error("The browser did not produce an SDP answer.");
      }

      this.sendSignal(
        {
          kind: "answer",
          description: {
            type: description.type,
            sdp: description.sdp
          }
        },
        this.remotePeerId
      );

      this.log("answer_sent", {});
      return;
    }

    if (message.kind === "answer" && this.role === "host") {
      if (
        !this.pc ||
        this.remotePeerId !== message.from ||
        !message.description?.sdp
      ) {
        return;
      }

      try {
        await this.pc.setRemoteDescription(message.description);
        await this.flushCandidates();
        this.log("answer_received", {});
      } catch (error) {
        this.emit("error", {
          code: "REMOTE_ANSWER_REJECTED",
          message: error.message
        });
        return;
      }

      if (
        this.negotiationPending &&
        this.pc.signalingState === "stable"
      ) {
        this.queueNegotiation();
      }

      return;
    }

    if (message.kind === "candidate") {
      if (!message.candidate) return;

      if (
        this.remotePeerId &&
        this.remotePeerId !== message.from
      ) {
        return;
      }

      this.remotePeerId = message.from;

      if (!this.pc || !this.pc.remoteDescription) {
        if (this.pendingCandidates.length < MAX_PENDING_CANDIDATES) {
          this.pendingCandidates.push(message.candidate);
        }
        return;
      }

      try {
        await this.pc.addIceCandidate(message.candidate);
      } catch (error) {
        this.log("candidate_rejected", {
          reason: error.message
        });
      }

      return;
    }

    if (message.kind === "leave") {
      if (message.from !== this.remotePeerId) return;

      this.remotePeerId = "";
      this.remoteRole = "";
      this.closePeerConnection();

      this.emit("message", {
        channel: "system",
        data: JSON.stringify({ type: "peer_left" })
      });
      this.emit("state", "disconnected");
      return;
    }

    if (message.kind === "error") {
      this.emit("error", {
        code: message.codeName || "SIGNALING_REMOTE_ERROR",
        message:
          message.message ||
          "The signaling server rejected the session."
      });

      if (
        message.codeName === "SESSION_BUSY" ||
        message.codeName === "NOT_JOINED"
      ) {
        this.remotePeerId = "";
        this.remoteRole = "";
      }
    }
  }

  async ensurePeerConnection(shouldOffer = false) {
    if (this.pc) {
      if (
        shouldOffer &&
        this.role === "host"
      ) {
        this.queueNegotiation();
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

      const candidate =
        typeof event.candidate.toJSON === "function"
          ? event.candidate.toJSON()
          : {
              candidate: event.candidate.candidate,
              sdpMid: event.candidate.sdpMid,
              sdpMLineIndex: event.candidate.sdpMLineIndex,
              usernameFragment: event.candidate.usernameFragment
            };

      this.sendSignal(
        {
          kind: "candidate",
          candidate
        },
        this.remotePeerId
      );
    };

    this.pc.onconnectionstatechange = () => {
      const value = this.pc?.connectionState || "closed";

      this.emit("state", value);
      this.log("connection_state", { state: value });

      if (value === "failed") {
        this.emit("error", {
          code: "WEBRTC_FAILED",
          message:
            "WebRTC could not establish a peer connection. A TURN server may be required on restrictive networks."
        });
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      this.emit(
        "ice",
        this.pc?.iceConnectionState || "closed"
      );
    };

    this.pc.onsignalingstatechange = () => {
      const state = this.pc?.signalingState || "closed";

      this.emit("signaling", {
        state,
        mode: this.signalingMode
      });

      if (
        state === "stable" &&
        this.negotiationPending &&
        this.role === "host"
      ) {
        this.queueNegotiation();
      }
    };

    this.pc.ondatachannel = (event) => {
      this.attachChannel(event.channel);
    };

    this.pc.ontrack = (event) => {
      const stream = event.streams?.[0];

      if (stream) {
        this.remoteStream = stream;
      } else if (
        event.track &&
        !this.remoteStream.getTracks().includes(event.track)
      ) {
        this.remoteStream.addTrack(event.track);
      }

      this.emit("track", {
        stream: stream || this.remoteStream,
        track: event.track
      });
    };

    this.pc.onnegotiationneeded = () => {
      if (
        this.role === "host" &&
        this.remotePeerId
      ) {
        this.queueNegotiation();
      }
    };

    if (this.role === "host") {
      for (const name of CHANNELS) {
        if (!this.channels.has(name)) {
          this.attachChannel(
            this.pc.createDataChannel(name, {
              ordered: name !== "input"
            })
          );
        }
      }

      if (this.localStream) {
        for (const track of this.localStream.getTracks()) {
          const existing = this.findSender(track.kind);
          if (existing) {
            await existing.replaceTrack(track);
          } else {
            const sender = this.pc.addTrack(track, this.localStream);
            if (track.kind === "video") {
              this.videoSender = sender;
            }
          }
        }
      }

      if (shouldOffer) {
        this.queueNegotiation();
      }
    }

    return this.pc;
  }

  findSender(kind) {
    if (kind === "video" && this.videoSender) {
      return this.videoSender;
    }

    return (
      this.pc
        ?.getSenders()
        .find((sender) => sender.track?.kind === kind) || null
    );
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
      this.emit("channel", {
        name: channel.label,
        state: "open"
      });
      this.log("channel_open", {
        channel: channel.label
      });
      this.flushPendingMessages(channel.label);
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
      if (typeof event.data !== "string") {
        this.emit("error", {
          code: "INVALID_CHANNEL_MESSAGE",
          message:
            "Binary data is not valid for this logical channel."
        });
        return;
      }

      if (
        !validateDataChannelMessage(
          channel.label,
          event.data
        )
      ) {
        this.emit("error", {
          code: "INVALID_CHANNEL_MESSAGE",
          message:
            "A malformed " +
            channel.label +
            " message was rejected."
        });
        return;
      }

      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }

      this.emit("message", {
        channel: channel.label,
        data
      });
    };
  }

  flushPendingMessages(channelName) {
    const channel = this.channels.get(channelName);
    const queue = this.pendingMessages.get(channelName);

    if (
      !channel ||
      channel.readyState !== "open" ||
      !queue?.length
    ) {
      return;
    }

    while (
      queue.length &&
      channel.readyState === "open" &&
      channel.bufferedAmount <= MAX_CHANNEL_BYTES
    ) {
      const payload = queue.shift();
      try {
        channel.send(payload);
      } catch {
        queue.unshift(payload);
        break;
      }
    }
  }

  async setLocalStream(stream) {
    if (this.role !== "host") {
      throw new Error("Only the host can share a screen.");
    }

    this.localStream = stream || null;

    if (!stream) {
      await this.clearLocalVideo();
      return;
    }

    if (!this.pc || !this.remotePeerId) {
      return;
    }

    let senderChanged = false;

    for (const track of stream.getTracks()) {
      let sender = this.findSender(track.kind);

      if (!sender) {
        sender = this.pc.addTrack(track, stream);
        senderChanged = true;

        if (track.kind === "video") {
          this.videoSender = sender;
        }
      } else {
        await sender.replaceTrack(track);
      }
    }

    if (senderChanged) {
      this.queueNegotiation();
    }
  }

  async clearLocalVideo() {
    if (!this.pc) {
      this.localStream = null;
      return;
    }

    const sender = this.videoSender || this.findSender("video");

    if (sender?.track) {
      await sender.replaceTrack(null);
    }

    this.localStream = null;

    if (sender && this.remotePeerId) {
      this.queueNegotiation();
    }

    this.emit("message", {
      channel: "system",
      data: JSON.stringify({
        type: "screen_stopped"
      })
    });
  }

  queueNegotiation() {
    if (
      this.closed ||
      this.role !== "host" ||
      !this.pc ||
      !this.remotePeerId
    ) {
      return;
    }

    this.negotiationPending = true;
    if (this.negotiationRunning) return;

    void this.pumpNegotiation();
  }

  async pumpNegotiation() {
    if (
      this.negotiationRunning ||
      this.closed ||
      this.role !== "host" ||
      !this.pc ||
      !this.remotePeerId
    ) {
      return;
    }

    if (this.pc.signalingState !== "stable") {
      return;
    }

    this.negotiationRunning = true;

    try {
      if (!this.negotiationPending) return;

      this.negotiationPending = false;

      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      const description = this.pc.localDescription;
      if (!description?.sdp) {
        throw new Error(
          "The browser did not produce a local SDP offer."
        );
      }

      const sent = this.sendSignal(
        {
          kind: "offer",
          description: {
            type: description.type,
            sdp: description.sdp
          }
        },
        this.remotePeerId
      );

      if (!sent) {
        this.negotiationPending = true;
        throw new Error(
          "The SDP offer could not be delivered to the signaling service."
        );
      }

      this.log("offer_sent", {
        hasVideo: this.pc
          .getSenders()
          .some((sender) => sender.track?.kind === "video")
      });
    } finally {
      this.negotiationRunning = false;
    }

    if (
      this.negotiationPending &&
      this.pc?.signalingState === "stable"
    ) {
      this.queueNegotiation();
    }
  }

  send(channel, message) {
    if (this.closed || !CHANNELS.includes(channel)) {
      return false;
    }

    let payload;
    try {
      payload =
        typeof message === "string"
          ? message
          : JSON.stringify(message);
    } catch {
      return false;
    }

    if (!payload || payload.length > MAX_CHANNEL_BYTES) {
      return false;
    }

    const target = this.channels.get(channel);
    if (!target || target.readyState === "connecting") {
      const queue = this.pendingMessages.get(channel);
      if (!queue) return false;

      if (queue.length >= MAX_PENDING_MESSAGES) {
        queue.shift();
      }

      queue.push(payload);
      return true;
    }

    if (
      target.readyState !== "open" ||
      target.bufferedAmount > MAX_CHANNEL_BYTES
    ) {
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
    if (!this.pc?.remoteDescription) {
      return Promise.resolve();
    }

    const candidates = this.pendingCandidates.splice(0);

    return candidates.reduce(
      (promise, candidate) =>
        promise.then(async () => {
          try {
            await this.pc.addIceCandidate(candidate);
          } catch (error) {
            this.log("candidate_rejected", {
              reason: error.message
            });
          }
        }),
      Promise.resolve()
    );
  }

  async getStats() {
    if (
      !this.pc ||
      this.pc.connectionState === "closed" ||
      typeof this.pc.getStats !== "function"
    ) {
      return null;
    }

    const reports = await this.pc.getStats();
    const result = {
      rtt: null,
      bitrate: null,
      fps: null,
      route: "unknown"
    };

    let selectedPair = null;

    reports.forEach((stat) => {
      if (
        stat.type === "transport" &&
        stat.selectedCandidatePairId
      ) {
        selectedPair =
          reports.get(stat.selectedCandidatePairId) || null;
      }

      if (
        !selectedPair &&
        stat.type === "candidate-pair" &&
        stat.state === "succeeded" &&
        (stat.selected || stat.nominated)
      ) {
        selectedPair = stat;
      }
    });

    if (selectedPair) {
      result.rtt =
        selectedPair.currentRoundTripTime != null
          ? Math.round(
              selectedPair.currentRoundTripTime * 1000
            )
          : null;

      const local = selectedPair.localCandidateId
        ? reports.get(selectedPair.localCandidateId)
        : null;

      result.route =
        local?.candidateType === "relay"
          ? "relay"
          : local?.candidateType || "direct";
    }

    const video = [...reports.values()].find(
      (stat) =>
        stat.type === "inbound-rtp" &&
        (stat.kind === "video" ||
          stat.mediaType === "video")
    );

    if (video) {
      const at = Date.now();

      result.fps = video.framesPerSecond
        ? Math.round(video.framesPerSecond)
        : null;

      result.bitrate = calculateBitrate(
        this.statsPrevious,
        {
          bytes: Number(video.bytesReceived || 0)
        },
        at
      );

      this.statsPrevious = {
        bytes: Number(video.bytesReceived || 0),
        at
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

    try {
      this.pc?.close();
    } catch {}

    this.pc = null;
    this.videoSender = null;

    this.pendingCandidates = [];
    this.pendingMessages.forEach((queue) => queue.splice(0));
    this.negotiationPending = false;
    this.negotiationRunning = false;
    this.statsPrevious = null;

    this.remoteStream
      .getTracks()
      .forEach((track) => {
        try { track.stop(); } catch {}
      });

    this.remoteStream = new MediaStream();
  }

  async close() {
    if (this.closed) return;

    const socket = this.signalingSocket;
    const peerId = this.remotePeerId;
    const shouldNotifyPeer =
      Boolean(
        peerId &&
        socket?.readyState === WebSocket.OPEN
      );

    if (shouldNotifyPeer) {
      this.sendSignal(
        { kind: "leave" },
        peerId,
        false
      );
    }

    this.closed = true;
    this.closePeerConnection();
    this.signalingSocket = null;

    this.emit("state", "closed");

    if (shouldNotifyPeer) {
      await new Promise((resolve) =>
        setTimeout(resolve, CLOSE_GRACE_MS)
      );
    }

    try {
      socket?.close();
    } catch {}
  }
}
