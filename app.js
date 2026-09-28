import { PeerSession } from "./webrtc.js";
import {
  validateInputMessage,
  validateControlMessage,
  generateSessionCode,
  normalizeSessionCode
} from "./protocol.js";

const config = window.P2P_DESK_CONFIG || {};
const state = {
  route: location.hash.slice(1) || "overview",
  role: "host",
  code: "",
  session: null,
  capture: null,
  peerConnected: false,
  controlGranted: false,
  allowControl: true,
  shareClipboard: false,
  logs: [],
  lastPointerSend: 0,
  activeControlRequestId: null,
  sessionStartedAt: 0
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const formatCode = (value) => {
  const digits = normalizeSessionCode(value);
  return digits.length > 3 ? digits.slice(0, 3) + " " + digits.slice(3) : digits;
};
const uid = () => generateSessionCode();

function navigate(route) {
  const allowed = ["overview", "sessions", "diagnostics", "docs"];
  const next = allowed.includes(route) ? route : "overview";
  state.route = next;
  history.replaceState({}, "", "#" + next);
  $$(".route").forEach((el) => el.classList.toggle("hidden", el.id !== "route-" + next));
  $$("[data-route]").forEach((el) => el.classList.toggle("active", el.dataset.route === next));
}

function logEvent(event, detail = {}, level = "info") {
  state.logs.unshift({ event, detail, level, at: new Date() });
  state.logs = state.logs.slice(0, 40);
  renderLogs();
}

function toast(message, type = "info") {
  const item = document.createElement("div");
  item.className = "toast " + type;
  item.textContent = (type === "error" ? "! " : type === "success" ? "✓ " : "i ") + message;
  $("#toastStack").appendChild(item);
  setTimeout(() => item.remove(), 4200);
}

function setConnection(stateName, tone = "gray") {
  const label = String(stateName || "idle").toUpperCase();
  $("#globalConnectionState").innerHTML = '<span class="status-dot ' + tone + '"></span> ' + label;
  $("#sessionBadge").textContent = label;
  $("#sessionBadge").className = "session-badge " + tone;
}

function updateControlButton() {
  const button = $("[data-action='control']");
  if (!button) return;
  button.innerHTML = state.role === "host"
    ? '<span>⌖</span> ' + (state.controlGranted ? "Revoke control" : "Control")
    : '<span>⌖</span> ' + (state.controlGranted ? "Control granted" : "Request control");
}

function resetSessionUi() {
  $("#emptySession").classList.remove("hidden");
  $("#activeSession").classList.add("hidden");
  $("#sessionTitle").textContent = "No active session";
  $("#peerLabel").textContent = "Waiting for a peer";
  $("#peerSubtext").textContent = "Create a host session, then join from a second browser.";
  $("#peerStatus").textContent = "WAITING";
  $("#captureLabel").textContent = "Share screen";
  $("#consentBanner").classList.add("hidden");
  $("#remoteVideo").srcObject = null;
  $("#remoteVideo").classList.remove("show");
  $("#videoPlaceholder").classList.remove("hidden");
  setConnection("idle", "gray");
  state.peerConnected = false;
  state.controlGranted = false;
  state.activeControlRequestId = null;
  updateControlButton();
}

function createSession(role = "host", code = uid()) {
  if (state.session) {
    try { state.session.close(); } catch {}
  }

  state.role = role;
  state.code = normalizeSessionCode(code);
  if (state.code.length !== 6) {
    toast("A valid six-digit session code is required.", "error");
    return;
  }

  state.peerConnected = false;
  state.controlGranted = false;
  state.activeControlRequestId = null;
  state.allowControl = $("#allowControl")?.checked ?? true;
  state.shareClipboard = $("#shareClipboard")?.checked ?? false;
  state.sessionStartedAt = Date.now();

  state.session = new PeerSession({
    code: state.code,
    role,
    iceServers: config.iceServers,
    signalingUrl: config.signalingUrl,
    onLog: (entry) => logEvent(entry.event, entry.detail)
  });

  wireSession(state.session);
  $("#emptySession").classList.add("hidden");
  $("#activeSession").classList.remove("hidden");
  $("#sessionCodeDisplay").textContent = formatCode(state.code);
  $("#sessionTitle").textContent = role === "host" ? "Host session" : "Controller session";
  $("#peerLabel").textContent = role === "host" ? "Waiting for a controller" : "Joining host";
  $("#peerSubtext").textContent = role === "host"
    ? "Share the code. View-only connection starts automatically."
    : "The host will establish a secure WebRTC connection.";
  $("#peerStatus").textContent = role === "host" ? "WAITING" : "JOINING";
  $("#captureLabel").textContent = role === "host" ? "Share screen" : "Host screen";
  updateControlButton();
  setConnection("signaling", "amber");
  navigate("sessions");

  state.session.connect().then(() => {
    logEvent("session_ready", { role, code: state.code, mode: state.session.signalingMode });
    if (role === "controller" && !state.session.targetPeerId) {
      toast("Connecting to the host session…", "info");
    }
  }).catch((error) => {
    setConnection("failed", "red");
    logEvent("session_connect_failed", { reason: error.message }, "error");
    toast(error.message, "error");
  });

  logEvent("session_created", { role, code: state.code });
  toast(role === "host" ? "Session " + formatCode(state.code) + " is ready." : "Joining " + formatCode(state.code) + ".", "success");
}

function wireSession(session) {
  session.on("state", (value) => {
    const connected = value === "connected" || value === "completed";
    state.peerConnected = connected;
    if (value === "new" || value === "connecting") setConnection("connecting", "amber");
    if (connected) {
      setConnection("connected", "green");
      $("#peerStatus").textContent = "CONNECTED";
      $("#peerLabel").textContent = state.role === "host" ? "Controller connected" : "Connected to host";
      $("#peerSubtext").textContent = state.controlGranted ? "Full control granted" : "Connected in view-only mode";
      toast("WebRTC peer connection established.", "success");
    }
    if (value === "failed") {
      setConnection("failed", "red");
      $("#peerStatus").textContent = "FAILED";
      toast("WebRTC connection failed. Check the signaling path and network.", "error");
    }
    if (value === "disconnected") {
      state.peerConnected = false;
      state.controlGranted = false;
      state.activeControlRequestId = null;
      updateControlButton();
      setConnection("disconnected", "red");
      $("#peerStatus").textContent = "DISCONNECTED";
      $("#consentBanner").classList.add("hidden");
      $("#remoteVideo").srcObject = null;
      $("#remoteVideo").classList.remove("show");
      $("#videoPlaceholder").classList.remove("hidden");
    }
    if (value === "closed") {
      setConnection("closed", "gray");
      $("#peerStatus").textContent = "CLOSED";
    }
    $("#diagHealth").textContent = connected ? "Connected" : String(value).replace(/^./, (c) => c.toUpperCase());
    $("#healthRing").textContent = connected ? "OK" : "—";
    $("#healthRing").style.borderColor = connected ? "var(--mint)" : "";
    $("#healthRing").style.color = connected ? "var(--mint)" : "";
    $("#diagConnection").textContent = value;
  });

  session.on("ice", (value) => {
    $("#diagIce").textContent = value;
    logEvent("ice_state", { state: value });
  });

  session.on("signaling", (detail) => {
    const value = detail?.state || detail;
    $("#diagSignaling").textContent = value;
    if (detail?.mode) {
      $("#diagSignaling").title = "Signaling mode: " + detail.mode;
    }
    if (detail?.peerId && state.role === "host" && state.session) {
      const inviteButton = $("[data-action='copy-invite']");
      if (inviteButton) inviteButton.dataset.inviteUrl = state.session.inviteUrl;
    }
  });

  session.on("channel", (detail) => {
    $("#diagData").textContent = detail.state === "open" ? detail.name + " open" : detail.state;
  });

  session.on("track", ({ stream }) => {
    const video = $("#remoteVideo");
    video.srcObject = stream;
    video.classList.add("show");
    $("#videoPlaceholder").classList.add("hidden");
    void video.play().catch(() => {});
    logEvent("remote_track", { tracks: stream.getTracks().length });
  });

  session.on("message", ({ channel, data }) => {
    let message;
    try {
      message = typeof data === "string" ? JSON.parse(data) : data;
    } catch {
      logEvent("invalid_data_message", { channel }, "error");
      return;
    }

    if (channel === "system") {
      if (message.type === "peer_joined" && state.role === "host") {
        $("#peerLabel").textContent = "Controller is joining";
        $("#peerSubtext").textContent = "Building the view-only WebRTC connection…";
        $("#peerStatus").textContent = "CONNECTING";
        logEvent("controller_joined", {});
        return;
      }
      if (message.type === "peer_left") {
        state.peerConnected = false;
        state.controlGranted = false;
        state.activeControlRequestId = null;
        $("#peerLabel").textContent = state.role === "host" ? "Waiting for a controller" : "Host disconnected";
        $("#peerSubtext").textContent = state.role === "host" ? "Share the code to invite a viewer" : "Start a new session to reconnect";
        $("#peerStatus").textContent = state.role === "host" ? "WAITING" : "DISCONNECTED";
        $("#consentBanner").classList.add("hidden");
        $("#remoteVideo").srcObject = null;
        $("#remoteVideo").classList.remove("show");
        $("#videoPlaceholder").classList.remove("hidden");
        setConnection(state.role === "host" ? "waiting" : "disconnected", state.role === "host" ? "amber" : "red");
        updateControlButton();
      }
      return;
    }

    if (channel === "control") {
      if (!validateControlMessage(message)) {
        logEvent("invalid_control_rejected", {}, "error");
        return;
      }

      if (message.type === "control_request" && state.role === "host") {
        if (!state.allowControl || state.controlGranted) {
          session.send("control", {
            type: "control_decision",
            requestId: message.requestId,
            granted: false
          });
          toast("Control request was kept view-only.", "info");
          return;
        }
        state.activeControlRequestId = message.requestId;
        $("#consentBanner").classList.remove("hidden");
        toast("A control request needs your approval.", "info");
        logEvent("control_requested_by_peer", {});
        return;
      }

      if (message.type === "control_decision" && state.role === "controller") {
        if (state.activeControlRequestId && message.requestId !== state.activeControlRequestId) return;
        state.activeControlRequestId = null;
        state.controlGranted = Boolean(message.granted);
        $("#peerSubtext").textContent = state.controlGranted
          ? "Full control granted — stop it any time"
          : "Connected in view-only mode";
        updateControlButton();
        toast(state.controlGranted ? "The host granted control." : "The host kept this session view-only.", state.controlGranted ? "success" : "info");
        logEvent("control_decision_received", { granted: state.controlGranted });
        return;
      }

      if (message.type === "control_revoked" && state.role === "controller") {
        state.controlGranted = false;
        state.activeControlRequestId = null;
        updateControlButton();
        $("#peerSubtext").textContent = "Connected in view-only mode";
        toast("The host revoked control.", "info");
        logEvent("control_revoked_received", {});
      }

      return;
    }

    if (channel === "input") {
      if (state.role !== "host" || !state.controlGranted || !validateInputMessage(message)) {
        logEvent("input_rejected", { reason: "no_control_or_invalid" }, "error");
        return;
      }
      logEvent("input_received", { type: message.type });
      return;
    }

    if (channel === "clipboard") {
      if (state.role !== "host" || (!state.shareClipboard && !state.controlGranted)) {
        logEvent("clipboard_rejected_no_consent", {}, "error");
        return;
      }
      logEvent("clipboard_message_received", {
        characters: typeof message.text === "string" ? message.text.length : 0
      });
    }
  });

  session.on("error", (detail) => {
    logEvent(detail.code || "error", detail, "error");
    toast(detail.message || "Connection error.", "error");
  });
}

async function startCapture() {
  if (state.role !== "host") {
    toast("Only the host can start browser screen sharing.", "info");
    return;
  }
  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast("This browser does not support screen capture.", "error");
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 60 } },
      audio: false
    });
    state.capture?.getTracks().forEach((track) => track.stop());
    state.capture = stream;
    const track = stream.getVideoTracks()[0];
    if (track) {
      track.onended = () => {
        state.capture = null;
        $("#captureLabel").textContent = "Share screen";
        state.session?.clearLocalVideo().catch((error) => logEvent("capture_stop_renegotiation_failed", { reason: error.message }, "error"));
        toast("Screen sharing stopped.", "info");
      };
    }

    $("#captureLabel").textContent = "Screen sharing";
    $("#videoTitle").textContent = "Screen sharing is active";
    $("#videoPlaceholder").classList.add("hidden");

    if (state.session) {
      await state.session.setLocalStream(stream);
    }

    logEvent("screen_capture_started", {
      tracks: stream.getTracks().length
    });
    toast("Screen sharing is active.", "success");
  } catch (error) {
    if (error?.name !== "NotAllowedError") {
      toast("Screen capture was unavailable.", "error");
    }
    logEvent("screen_capture_denied", { reason: error?.name || "unknown" });
  }
}

function sendControlRequest() {
  if (!state.session || !state.peerConnected) {
    toast("Wait until the WebRTC connection is connected.", "info");
    return;
  }

  if (state.role === "host") {
    if (state.controlGranted) {
      state.controlGranted = false;
      state.session.send("control", { type: "control_revoked", reason: "host_revoked" });
      $("#peerSubtext").textContent = "Connected in view-only mode";
      updateControlButton();
      toast("Control revoked.", "info");
      logEvent("control_revoked", {});
    } else {
      toast("The controller must request control.", "info");
    }
    return;
  }

  if (state.controlGranted) {
    toast("Control is already granted.", "info");
    return;
  }

  const requestId = globalThis.crypto?.randomUUID?.() || "req-" + Date.now().toString(16) + "-" + Math.random().toString(16).slice(2);
  state.activeControlRequestId = requestId;
  state.session.send("control", {
    type: "control_request",
    requestId,
    requestedAt: Date.now()
  });
  toast("Control request sent to the host.", "success");
  logEvent("control_requested", {});
}

async function grantControl(granted) {
  if (state.role !== "host" || !state.session || !state.peerConnected) {
    toast("The peer must be connected before control can be granted.", "info");
    return;
  }

  const requestId = state.activeControlRequestId;
  if (!requestId) {
    toast("No active control request.", "info");
    return;
  }

  state.activeControlRequestId = null;
  state.controlGranted = Boolean(granted);
  $("#consentBanner").classList.add("hidden");
  state.session.send("control", {
    type: "control_decision",
    requestId,
    granted: state.controlGranted
  });

  $("#peerSubtext").textContent = state.controlGranted
    ? "Full control granted — stop it any time"
    : "Connected in view-only mode";
  updateControlButton();
  toast(state.controlGranted ? "Full control granted." : "View-only mode kept.", state.controlGranted ? "success" : "info");
  logEvent("control_decision", { granted: state.controlGranted });
}

async function disconnect() {
  const session = state.session;
  state.session = null;
  state.sessionStartedAt = 0;

  if (session) {
    try {
      await session.close();
    } catch (error) {
      logEvent("session_close_failed", { reason: error.message }, "error");
    }
  }

  state.capture?.getTracks().forEach((track) => {
    try { track.stop(); } catch {}
  });
  state.capture = null;

  resetSessionUi();
  navigate("sessions");
  logEvent("session_closed", {});
  toast("Session ended.", "info");
}

function renderLogs() {
  const list = $("#eventLog");
  if (!state.logs.length) {
    list.innerHTML = '<div class="log-empty">Events from this browser session will appear here.</div>';
    return;
  }
  list.innerHTML = state.logs.slice(0, 12).map((entry) => {
    const detail = Object.keys(entry.detail || {}).length ? JSON.stringify(entry.detail) : "—";
    return '<div class="log-entry ' + entry.level + '"><span class="log-dot"></span><span class="log-time">' +
      entry.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) +
      '</span><strong>' + entry.event.replaceAll("_", " ") +
      '</strong><small>' + detail.replaceAll("<", "&lt;").replaceAll(">", "&gt;") + "</small></div>";
  }).join("");
}

async function refreshStats() {
  try {
    const stats = await state.session?.getStats();
    if (!stats) return;
    $("#metricRtt").textContent = stats.rtt ?? "—";
    $("#metricBitrate").textContent = stats.bitrate ?? "—";
    $("#metricFps").textContent = stats.fps ?? "—";
    $("#metricRoute").textContent = stats.route === "unknown" ? "—" : stats.route;
  } catch (error) {
    logEvent("stats_failed", { reason: error.message }, "error");
  }
}

function handlePointer(event) {
  if (!state.controlGranted || state.role !== "controller" || !state.session?.pc) return;
  const now = performance.now();
  if (now - state.lastPointerSend < 40) return;
  const rect = event.currentTarget.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const message = {
    type: "mouse_move",
    timestamp: Date.now(),
    x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    monitorId: "browser-display"
  };
  if (validateInputMessage(message)) state.session.send("input", message);
  state.lastPointerSend = now;
}

function sendInput(message) {
  if (state.role !== "controller" || !state.controlGranted || !validateInputMessage(message)) return;
  state.session?.send("input", message);
}

function modifierNames(event) {
  return ["CTRL", "ALT", "SHIFT", "META"].filter((name) => event[name.toLowerCase() + "Key"]);
}

function copy(value, label) {
  if (!navigator.clipboard) {
    toast("Clipboard permission was unavailable.", "error");
    return;
  }
  navigator.clipboard.writeText(value)
    .then(() => toast(label + " copied.", "success"))
    .catch(() => toast("Clipboard permission was unavailable.", "error"));
}

function bindEvents() {
  window.addEventListener("hashchange", () => navigate(location.hash.slice(1) || "overview"));

  $$("[data-route]").forEach((link) => link.addEventListener("click", () => navigate(link.dataset.route)));

  $$("[data-role]").forEach((button) => button.addEventListener("click", () => {
    if (state.session) {
      toast("End the active session before changing roles.", "info");
      return;
    }
    state.role = button.dataset.role;
    $$("[data-role]").forEach((el) => el.classList.toggle("selected", el === button));
    $("#hostForm").classList.toggle("hidden", state.role !== "host");
    $("#controllerForm").classList.toggle("hidden", state.role !== "controller");
    updateControlButton();
  }));

  $$("[data-action='create-host']").forEach((button) => button.addEventListener("click", () => createSession("host")));

  $("[data-action='join-session']").addEventListener("click", () => {
    navigate("sessions");
    $("[data-role='controller']").click();
    setTimeout(() => $("#joinCode").focus(), 50);
  });

  $("[data-action='join-code']").addEventListener("click", () => {
    const code = normalizeSessionCode($("#joinCode").value);
    if (code.length !== 6) {
      toast("Enter the six-digit session code, or open the host invite link.", "error");
      return;
    }
    createSession("controller", code);
  });

  $("#joinCode").addEventListener("input", (event) => {
    event.target.value = formatCode(event.target.value);
    event.target.setSelectionRange(event.target.value.length, event.target.value.length);
  });

  $("[data-action='capture']").addEventListener("click", startCapture);
  $("[data-action='control']").addEventListener("click", sendControlRequest);
  $("[data-action='approve-control']").addEventListener("click", () => grantControl(true));
  $("[data-action='reject-control']").addEventListener("click", () => grantControl(false));
  $("[data-action='disconnect']").addEventListener("click", disconnect);
  $("[data-action='copy-code']").addEventListener("click", () => copy(state.code, "Session code"));
  $("[data-action='copy-invite']").addEventListener("click", () => {
    if (state.role !== "host") {
      toast("Only the host can share the invite link.", "info");
      return;
    }
    const url = state.session?.inviteUrl;
    if (!url) {
      toast("The secure session link is not ready yet. Please wait a moment.", "info");
      return;
    }
    copy(url, "Invite link");
  });

  $("[data-action='copy-text']").addEventListener("click", () => {
    if (state.role !== "controller" || !state.peerConnected) {
      toast("Connect to a host first.", "info");
      return;
    }
    if (!state.shareClipboard && !state.controlGranted) {
      toast("Clipboard sharing requires host approval.", "info");
      return;
    }
    if (!navigator.clipboard) {
      toast("Clipboard permission was unavailable.", "error");
      return;
    }
    navigator.clipboard.readText().then((text) => {
      if (new TextEncoder().encode(text).byteLength > 100 * 1024) {
        toast("Clipboard text is too large.", "error");
        return;
      }
      if (state.session?.send("clipboard", { type: "clipboard_text", text })) {
        toast("Clipboard text sent.", "success");
      } else {
        toast("Clipboard channel is not connected yet.", "info");
      }
    }).catch(() => toast("Clipboard permission was unavailable.", "error"));
  });

  $("[data-action='refresh-stats']").addEventListener("click", refreshStats);
  $("[data-action='clear-log']").addEventListener("click", () => {
    state.logs = [];
    renderLogs();
  });

  $("#remoteVideo").addEventListener("pointermove", handlePointer);
  $("#remoteVideo").addEventListener("pointerdown", (event) => sendInput({
    type: "mouse_button",
    button: event.button === 2 ? "right" : event.button === 1 ? "middle" : "left",
    action: "down",
    timestamp: Date.now()
  }));
  $("#remoteVideo").addEventListener("pointerup", (event) => sendInput({
    type: "mouse_button",
    button: event.button === 2 ? "right" : event.button === 1 ? "middle" : "left",
    action: "up",
    timestamp: Date.now()
  }));
  $("#remoteVideo").addEventListener("dblclick", () => sendInput({
    type: "mouse_button",
    button: "left",
    action: "double",
    timestamp: Date.now()
  }));
  $("#remoteVideo").addEventListener("contextmenu", (event) => event.preventDefault());
  $("#remoteVideo").addEventListener("wheel", (event) => {
    event.preventDefault();
    sendInput({ type: "scroll", deltaX: event.deltaX, deltaY: event.deltaY, timestamp: Date.now() });
  }, { passive: false });
  $("#remoteVideo").addEventListener("keydown", (event) => {
    if (state.role !== "controller" || !state.controlGranted) return;
    event.preventDefault();
    sendInput({
      type: "keyboard",
      key: event.key,
      code: event.code,
      action: "down",
      modifiers: modifierNames(event),
      timestamp: Date.now()
    });
  });
  $("#remoteVideo").addEventListener("keyup", (event) => {
    if (state.role !== "controller" || !state.controlGranted) return;
    event.preventDefault();
    sendInput({
      type: "keyboard",
      key: event.key,
      code: event.code,
      action: "up",
      modifiers: modifierNames(event),
      timestamp: Date.now()
    });
  });

  $("#themeToggle").addEventListener("click", () => document.body.classList.toggle("light"));
  setInterval(refreshStats, 3000);
  setInterval(() => {
    if (state.session && state.sessionStartedAt && Date.now() - state.sessionStartedAt > (Number(config.sessionTtlMinutes) || 30) * 60 * 1000) {
      logEvent("session_expired_client", {}, "error");
      disconnect();
      toast("Session expired.", "info");
    }
  }, 5000);
}

bindEvents();
navigate(state.route);
const inviteParams = new URLSearchParams(location.search);
const inviteCode = normalizeSessionCode(inviteParams.get("code") || "");
if (inviteCode.length === 6) {
  setTimeout(() => {
    navigate("sessions");
    $("[data-role]").forEach((el) => el.classList.toggle("selected", el.dataset.role === "controller"));
    $("#hostForm").classList.add("hidden");
    $("#controllerForm").classList.remove("hidden");
    createSession("controller", inviteCode);
  }, 0);
}
renderLogs();
logEvent("client_ready", {
  protocol: config.protocolVersion || "1.1.0",
  signaling: config.signalingUrl ? "websocket" : "same_origin_tabs_only",
  secureContext: window.isSecureContext
});
