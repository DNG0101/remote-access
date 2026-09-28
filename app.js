import { PeerSession, validateInputMessage } from "./webrtc.js";

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
  lastPointerSend: 0
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const formatCode = (value) => {
  const digits = String(value).replace(/\D/g, "").slice(0, 6);
  return digits.length > 3 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : digits;
};
const uid = () => {
  const bytes = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
  return String(bytes).padStart(6, "0");
};

function navigate(route) {
  state.route = route;
  history.replaceState({}, "", `#${route}`);
  $$(".route").forEach((el) => el.classList.toggle("hidden", el.id !== `route-${route}`));
  $$("[data-route]").forEach((el) => el.classList.toggle("active", el.dataset.route === route));
}

function logEvent(event, detail = {}, level = "info") {
  state.logs.unshift({ event, detail, level, at: new Date() });
  state.logs = state.logs.slice(0, 40);
  renderLogs();
}

function toast(message, type = "info") {
  const item = document.createElement("div");
  item.className = `toast ${type}`;
  item.innerHTML = `<span>${type === "error" ? "!" : type === "success" ? "✓" : "i"}</span><p>${message}</p>`;
  $("#toastStack").appendChild(item);
  setTimeout(() => item.remove(), 4200);
}

function setConnection(stateName, tone = "gray") {
  const label = stateName.toUpperCase();
  $("#globalConnectionState").innerHTML = `<span class="status-dot ${tone}"></span> ${label}`;
  $("#sessionBadge").textContent = label;
  $("#sessionBadge").className = `session-badge ${tone}`;
}

function createSession(role = "host", code = uid()) {
  if (state.session) state.session.close();
  state.role = role;
  state.code = code.replace(/\D/g, "").slice(0, 6);
  state.allowControl = $("#allowControl")?.checked ?? true;
  state.shareClipboard = $("#shareClipboard")?.checked ?? false;
  state.session = new PeerSession({ code: state.code, role, iceServers: config.iceServers, onLog: (entry) => logEvent(entry.event, entry.detail) });
  wireSession(state.session);
  state.session.connect().catch((error) => toast(error.message, "error"));
  $("#emptySession").classList.add("hidden");
  $("#activeSession").classList.remove("hidden");
  $("#sessionCodeDisplay").textContent = formatCode(state.code);
  $("#sessionTitle").textContent = role === "host" ? "Host session" : "Controller session";
  $("#peerLabel").textContent = role === "host" ? "Waiting for a peer" : "Waiting for host approval";
  $("#peerSubtext").textContent = role === "host" ? "Share the code to invite a viewer" : "The host will choose view-only or full control";
  $("#peerStatus").textContent = role === "host" ? "WAITING" : "REQUESTED";
  $("#captureLabel").textContent = role === "host" ? "Share screen" : "Host screen";
  setConnection("waiting", "amber");
  navigate("sessions");
  logEvent("session_created", { role, code: state.code });
  toast(role === "host" ? `Session ${formatCode(state.code)} is ready.` : "Join request sent to the host.", "success");
}

function wireSession(session) {
  session.on("state", (value) => {
    state.peerConnected = ["connected", "completed"].includes(value);
    if (value === "connected") { setConnection("connected", "green"); $("#peerStatus").textContent = "CONNECTED"; toast("Peer connection established.", "success"); }
    if (value === "connecting") setConnection("connecting", "amber");
    if (value === "failed") { setConnection("failed", "red"); toast("The peer connection failed. Check signaling or network access.", "error"); }
    if (value === "closed") { setConnection("closed", "gray"); $("#peerStatus").textContent = "CLOSED"; }
    $("#diagHealth").textContent = value === "connected" ? "Connected" : value[0].toUpperCase() + value.slice(1);
    $("#healthRing").textContent = value === "connected" ? "OK" : "—";
    $("#healthRing").style.borderColor = value === "connected" ? "var(--mint)" : "";
    $("#healthRing").style.color = value === "connected" ? "var(--mint)" : "";
    $("#diagConnection").textContent = value;
  });
  session.on("ice", (value) => { $("#diagIce").textContent = value; logEvent("ice_state", { state: value }); });
  session.on("signaling", (detail) => { $("#diagSignaling").textContent = detail?.state || detail; });
  session.on("channel", (detail) => { $("#diagData").textContent = detail.state === "open" ? `${detail.name} open` : detail.state; });
  session.on("track", ({ stream }) => {
    $("#remoteVideo").srcObject = stream;
    $("#remoteVideo").classList.add("show");
    $("#videoPlaceholder").classList.add("hidden");
    logEvent("remote_track", { kind: "video" });
  });
  session.on("message", ({ channel, data }) => {
    try {
      const message = typeof data === "string" ? JSON.parse(data) : data;
      if (message.type === "peer_joined" && state.role === "host") {
        $("#peerLabel").textContent = "Viewer is requesting access";
        $("#peerSubtext").textContent = "Accept view-only, then optionally grant control";
        $("#peerStatus").textContent = "REQUEST";
        $("#consentBanner").classList.remove("hidden");
        toast("A viewer is waiting for your approval.");
      }
      if (message.type === "control_request") {
        if (state.role === "host" && state.allowControl) {
          $("#consentBanner").classList.remove("hidden");
          toast("Control request needs your approval.");
        } else if (state.role === "host") {
          session.send("control", { type: "control_decision", granted: false });
          toast("Control request blocked by the host setting.", "info");
        }
      }
      if (message.type === "control_decision" && state.role === "controller") {
        state.controlGranted = Boolean(message.granted);
        $("#peerSubtext").textContent = state.controlGranted ? "Full control granted — stop it any time" : "Connected in view-only mode";
        $("[data-action=\"control\"]").textContent = state.controlGranted ? "⌖ Revoke control" : "⌖ Request control";
        toast(state.controlGranted ? "The host granted control." : "The host kept this session view-only.", state.controlGranted ? "success" : "info");
        logEvent("control_decision_received", { granted: state.controlGranted });
      }
      if (channel === "input") {
        if (state.role !== "host" || !state.controlGranted) {
          logEvent("input_rejected_no_control", {}, "error");
          return;
        }
        if (validateInputMessage(message)) logEvent("input_received", { type: message.type });
        else logEvent("invalid_input_rejected", {}, "error");
      }
      if (channel === "clipboard") {
        if (state.role !== "host" || (!state.shareClipboard && !state.controlGranted)) {
          logEvent("clipboard_rejected_no_consent", {}, "error");
          return;
        }
        logEvent("clipboard_message_received", { characters: typeof message.text === "string" ? message.text.length : 0 });
      }
    } catch { logEvent("data_message", { channel }); }
  });
  session.on("error", (detail) => { logEvent(detail.code || "error", detail, "error"); toast(detail.message || "Connection error.", "error"); });
}

async function startCapture() {
  if (state.role !== "host") { toast("Only the host can start browser screen sharing.", "info"); return; }
  if (!navigator.mediaDevices?.getDisplayMedia) { toast("This browser does not support screen capture.", "error"); return; }
  try {
    state.capture = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 60 } }, audio: false });
    state.capture.getVideoTracks()[0].onended = () => { state.capture = null; $("#captureLabel").textContent = "Share screen"; state.session?.clearLocalVideo().catch(() => {}); toast("Screen sharing stopped.", "info"); };
    $("#captureLabel").textContent = "Screen sharing";
    $("#videoTitle").textContent = "Screen sharing is active";
    $("#videoPlaceholder").classList.remove("hidden");
    if (state.session?.pc && state.session.pc.connectionState !== "closed") {
      const senders = state.session.pc.getSenders();
      state.capture.getTracks().forEach((track) => senders.find((sender) => sender.track?.kind === track.kind)?.replaceTrack(track));
      if (!senders.some((sender) => sender.track?.kind === "video")) {
        state.capture.getTracks().forEach((track) => state.session.pc.addTrack(track, state.capture));
        await state.session.accept({ stream: state.capture });
      }
    }
    logEvent("screen_capture_started", { tracks: state.capture.getTracks().length });
    toast("Choose a window or display in the browser prompt.", "success");
  } catch (error) { if (error.name !== "NotAllowedError") toast("Screen capture was unavailable.", "error"); logEvent("screen_capture_denied", { reason: error.name }); }
}

function sendControlRequest() {
  if (state.role === "host") {
    if (state.controlGranted) revokeControl();
    else toast("Control is view-only until the controller requests it.", "info");
    return;
  }
  if (!state.session || !state.peerConnected) { toast("Connect to a host before requesting control.", "info"); return; }
  state.session?.send("control", { type: "control_request", requestedAt: Date.now() });
  toast("Control request sent to the host.", "success");
  logEvent("control_requested", {});
}

async function grantControl(granted) {
  state.controlGranted = granted;
  $("#consentBanner").classList.add("hidden");
  if (state.role === "host" && !state.session?.pc) {
    try {
      await state.session.accept({ stream: state.capture });
      $("#peerLabel").textContent = "Viewer connected";
      $("#peerStatus").textContent = "CONNECTED";
    } catch (error) {
      toast("The peer handshake could not start.", "error");
      logEvent("handshake_start_failed", { reason: error.message }, "error");
      return;
    }
  }
  state.session?.send("control", { type: "control_decision", granted });
  $("#peerSubtext").textContent = granted ? "Full control granted — stop it any time" : "Connected in view-only mode";
  $("[data-action=\"control\"]").textContent = granted ? "⌖ Revoke control" : "⌖ Request control";
  toast(granted ? "Full control granted." : "View-only mode kept.", granted ? "success" : "info");
  logEvent("control_decision", { granted });
}

function disconnect() {
  state.capture?.getTracks().forEach((track) => track.stop());
  state.session?.close();
  state.session = null;
  state.capture = null;
  state.peerConnected = false;
  $("#activeSession").classList.add("hidden");
  $("#emptySession").classList.remove("hidden");
  $("#sessionTitle").textContent = "No active session";
  setConnection("idle", "gray");
  navigate("sessions");
  logEvent("session_closed", {});
  toast("Session ended.", "info");
}

function renderLogs() {
  const list = $("#eventLog");
  if (!state.logs.length) { list.innerHTML = `<div class="log-empty">Events from this browser session will appear here.</div>`; return; }
  list.innerHTML = state.logs.slice(0, 12).map((entry) => `<div class="log-entry ${entry.level}"><span class="log-dot"></span><span class="log-time">${entry.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span><strong>${entry.event.replaceAll("_", " ")}</strong><small>${Object.keys(entry.detail || {}).length ? JSON.stringify(entry.detail) : "—"}</small></div>`).join("");
}

async function refreshStats() {
  const stats = await state.session?.getStats();
  if (!stats) return;
  $("#metricRtt").textContent = stats.rtt ?? "—";
  $("#metricBitrate").textContent = stats.bitrate ?? "—";
  $("#metricFps").textContent = stats.fps ?? "—";
  $("#metricRoute").textContent = stats.route === "unknown" ? "—" : stats.route;
}

function handlePointer(event) {
  if (!state.controlGranted || !state.session?.pc) return;
  const now = performance.now();
  if (now - state.lastPointerSend < 40) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const message = { type: "mouse_move", timestamp: Date.now(), x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)), monitorId: "browser-display" };
  if (validateInputMessage(message)) state.session.send("input", message);
  state.lastPointerSend = now;
}

function sendInput(message) {
  if (!state.controlGranted || state.role !== "controller" || !validateInputMessage(message)) return;
  state.session?.send("input", message);
}

function modifierNames(event) {
  return ["CTRL", "ALT", "SHIFT", "META"].filter((name) => event[`${name.toLowerCase()}Key`]);
}

function copy(value, label) {
  if (!navigator.clipboard) return toast("Clipboard permission was unavailable.", "error");
  navigator.clipboard.writeText(value).then(() => toast(`${label} copied.`, "success")).catch(() => toast("Clipboard permission was unavailable.", "error"));
}

function bindEvents() {
  window.addEventListener("hashchange", () => navigate(location.hash.slice(1) || "overview"));
  $$("[data-route]").forEach((link) => link.addEventListener("click", () => navigate(link.dataset.route)));
  $$("[data-role]").forEach((button) => button.addEventListener("click", () => { state.role = button.dataset.role; $$("[data-role]").forEach((el) => el.classList.toggle("selected", el === button)); $("#hostForm").classList.toggle("hidden", state.role !== "host"); $("#controllerForm").classList.toggle("hidden", state.role !== "controller"); }));
  $$("[data-action='create-host']").forEach((button) => button.addEventListener("click", () => createSession("host")));
  $("[data-action='join-session']").addEventListener("click", () => { navigate("sessions"); $("[data-role='controller']").click(); setTimeout(() => $("#joinCode").focus(), 50); });
  $("[data-action='join-code']").addEventListener("click", () => { const code = $("#joinCode").value.replace(/\D/g, ""); if (code.length !== 6) return toast("Enter the six-digit session code.", "error"); createSession("controller", code); });
  $("#joinCode").addEventListener("input", (event) => {
    event.target.value = formatCode(event.target.value);
    event.target.setSelectionRange(event.target.value.length, event.target.value.length);
  });
  $("[data-action='capture']").addEventListener("click", startCapture);
  $("[data-action='control']").addEventListener("click", sendControlRequest);
  $("[data-action='approve-control']").addEventListener("click", () => grantControl(true));
  $("[data-action='reject-control']").addEventListener("click", () => grantControl(false));
  $("[data-action='disconnect']").addEventListener("click", disconnect);
  $("[data-action='control']").setAttribute("aria-label", "Request or revoke control");
  $("[data-action='copy-code']").addEventListener("click", () => copy(state.code, "Session code"));
  $("[data-action='copy-text']").addEventListener("click", () => {
    if (!navigator.clipboard) return toast("Clipboard permission was unavailable.", "error");
    navigator.clipboard.readText().then((text) => {
      if (state.session?.send("clipboard", { type: "clipboard_text", text })) toast("Clipboard text sent after your request.", "success");
      else toast("Clipboard channel is not connected yet.", "info");
    }).catch(() => toast("Clipboard permission was unavailable.", "error"));
  });
  $("[data-action='refresh-stats']").addEventListener("click", refreshStats);
  $("[data-action='clear-log']").addEventListener("click", () => { state.logs = []; renderLogs(); });
  $("#remoteVideo").addEventListener("pointermove", handlePointer);
  $("#remoteVideo").addEventListener("pointerdown", (event) => sendInput({ type: "mouse_button", button: event.button === 2 ? "right" : event.button === 1 ? "middle" : "left", action: "down", timestamp: Date.now() }));
  $("#remoteVideo").addEventListener("pointerup", (event) => sendInput({ type: "mouse_button", button: event.button === 2 ? "right" : event.button === 1 ? "middle" : "left", action: "up", timestamp: Date.now() }));
  $("#remoteVideo").addEventListener("dblclick", () => sendInput({ type: "mouse_button", button: "left", action: "double", timestamp: Date.now() }));
  $("#remoteVideo").addEventListener("contextmenu", (event) => event.preventDefault());
  $("#remoteVideo").addEventListener("wheel", (event) => { event.preventDefault(); sendInput({ type: "scroll", deltaX: event.deltaX, deltaY: event.deltaY, timestamp: Date.now() }); }, { passive: false });
  $("#remoteVideo").addEventListener("keydown", (event) => {
    if (state.role !== "controller" || !state.controlGranted) return;
    event.preventDefault();
    sendInput({ type: "keyboard", key: event.key, code: event.code, action: "down", modifiers: modifierNames(event), timestamp: Date.now() });
  });
  $("#remoteVideo").addEventListener("keyup", (event) => {
    if (state.role !== "controller" || !state.controlGranted) return;
    event.preventDefault();
    sendInput({ type: "keyboard", key: event.key, code: event.code, action: "up", modifiers: modifierNames(event), timestamp: Date.now() });
  });
  $("#themeToggle").addEventListener("click", () => document.body.classList.toggle("light"));
  setInterval(refreshStats, 3000);
}

bindEvents();
navigate(state.route);
renderLogs();
logEvent("client_ready", { protocol: config.protocolVersion || "1.0.0" });