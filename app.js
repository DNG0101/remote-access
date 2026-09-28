import { PeerSession } from "./webrtc.js";
import { NativeAgentClient } from "./agent-client.js";
import {
  validateInputMessage,
  validateControlMessage,
  validateChatMessage,
  validateFileTransferMessage,
  validateTelemetryMessage,
  generateSessionCode,
  normalizeSessionCode,
  MAX_FILE_BYTES,
  MAX_FILE_CHUNK_BYTES
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
  sessionStartedAt: 0,
  chatMessages: [],
  incomingFile: null,
  outgoingFile: null,
  peerCapabilities: null,
  incomingClipboard: null,
  completedFile: null,
  nativeAgent: null,
  nativeAgentWarned: false
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

function updateClipboardButton() {
  const button = $("[data-action='copy-text']");
  if (!button) return;

  if (state.role === "controller" && state.incomingClipboard !== null) {
    button.innerHTML = '<span>□</span> Copy host clipboard';
  } else {
    button.innerHTML = state.role === "host"
      ? '<span>□</span> Send host clipboard'
      : '<span>□</span> Send clipboard';
  }
}

function setModuleStatus(id, value, tone = "") {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = value;
  el.className = "module-status" + (tone ? " " + tone : "");
}

function renderChat() {
  const list = $("#chatList");
  if (!list) return;

  if (!state.chatMessages.length) {
    list.innerHTML = '<div class="chat-empty">Messages are end-to-end over the WebRTC data channel.</div>';
    return;
  }

  list.innerHTML = state.chatMessages.slice(-40).map((entry) => {
    const safe = entry.text.replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");

    return '<div class="chat-message ' + entry.side + '"><small>' +
      (entry.side === "me" ? "YOU" : "PEER") +
      '</small><span>' + safe + '</span></div>';
  }).join("");

  list.scrollTop = list.scrollHeight;
}

function addChatMessage(text, side) {
  state.chatMessages.push({
    text: String(text),
    side: side === "me" ? "me" : "peer",
    at: Date.now()
  });
  renderChat();
}

function resetModules() {
  state.chatMessages = [];
  state.incomingFile = null;
  state.outgoingFile = null;
  state.peerCapabilities = null;
  state.incomingClipboard = null;
  if (state.completedFile?.url) {
    URL.revokeObjectURL(state.completedFile.url);
  }
  state.completedFile = null;
  renderChat();
  updateClipboardButton();

  setModuleStatus("chatStatus", "OFFLINE");
  setModuleStatus("fileStatus", "READY");
  setModuleStatus("nativeStatus", "OFFLINE");
  if ($("#nativeMessage")) {
    $("#nativeMessage").textContent =
      "Optional local agent for real PC mouse and keyboard control. The browser remains the consent boundary.";
  }
  $("#fileProgress")?.classList.add("hidden");
  $("#fileOffer")?.classList.add("hidden");
  if ($("#fileInput")) $("#fileInput").value = "";
}

function updateFileProgress(label, percent) {
  const panel = $("#fileProgress");
  const bar = $("#fileProgressBar");
  const value = $("#fileProgressValue");
  const text = $("#fileProgressLabel");

  if (!panel || !bar || !value || !text) return;

  panel.classList.remove("hidden");
  bar.value = Math.max(0, Math.min(100, percent));
  value.textContent = Math.round(bar.value) + "%";
  text.textContent = label;
}

function transferId() {
  return (
    globalThis.crypto?.randomUUID?.() ||
    "file-" + Date.now().toString(36) + "-" +
    Math.random().toString(36).slice(2, 12)
  ).replace(/[^A-Za-z0-9_-]/g, "");
}

function bytesToBase64(bytes) {
  let binary = "";
  const step = 0x8000;

  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(
      ...bytes.subarray(index, Math.min(index + step, bytes.length))
    );
  }

  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

async function waitForChannel(session, name, timeoutMs = 10_000) {
  const started = Date.now();

  while (!session.closed && Date.now() - started < timeoutMs) {
    const channel = session.channels?.get(name);
    if (channel?.readyState === "open") return channel;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(name + " data channel did not open.");
}

async function sendFile(file) {
  if (!state.session || !state.peerConnected) {
    toast("Connect to a peer before sending a file.", "info");
    return;
  }

  if (!(file instanceof File)) return;

  if (file.size > MAX_FILE_BYTES) {
    toast("Files are limited to 25 MB in the browser client.", "error");
    return;
  }

  const totalChunks = file.size === 0
    ? 0
    : Math.ceil(file.size / MAX_FILE_CHUNK_BYTES);

  if (totalChunks > 512) {
    toast("This file is too large for the browser transfer protocol.", "error");
    return;
  }

  const id = transferId();
  if (state.completedFile?.url) {
    URL.revokeObjectURL(state.completedFile.url);
    state.completedFile = null;
  }

  $("[data-action='save-file']").classList.add("hidden");
  $("[data-action='reject-file']").classList.remove("hidden");
  $("[data-action='accept-file']").classList.remove("hidden");

  state.outgoingFile = {
    id,
    file,
    totalChunks,
    accepted: false
  };

  setModuleStatus("fileStatus", "OFFERING", "amber");
  updateFileProgress("Waiting for peer approval…", 0);

  const sent = state.session.send("file-transfer", {
    type: "file_offer",
    transferId: id,
    name: file.name,
    mime: file.type || "application/octet-stream",
    size: file.size,
    totalChunks
  });

  if (!sent) {
    state.outgoingFile = null;
    setModuleStatus("fileStatus", "READY");
    $("#fileProgress")?.classList.add("hidden");
    toast("The file channel is not available yet.", "error");
    return;
  }

  toast("File offer sent.", "success");
}

async function sendOutgoingFile() {
  const transfer = state.outgoingFile;
  if (!transfer?.accepted || !state.session) return;

  try {
    const channel = await waitForChannel(state.session, "file-transfer");
    const { file, totalChunks, id } = transfer;

    for (let index = 0; index < totalChunks; index++) {
      const start = index * MAX_FILE_CHUNK_BYTES;
      const end = Math.min(file.size, start + MAX_FILE_CHUNK_BYTES);
      const buffer = await file.slice(start, end).arrayBuffer();
      const data = bytesToBase64(new Uint8Array(buffer));

      while (
        channel.bufferedAmount > 192 * 1024 &&
        channel.readyState === "open"
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      if (channel.readyState !== "open") {
        throw new Error("The file-transfer channel closed.");
      }

      if (!state.session.send("file-transfer", {
        type: "file_chunk",
        transferId: id,
        index,
        data
      })) {
        throw new Error("A file chunk could not be sent.");
      }

      updateFileProgress(
        "Sending " + file.name,
        ((index + 1) / totalChunks) * 100
      );
    }

    state.session.send("file-transfer", {
      type: "file_complete",
      transferId: id
    });

    setModuleStatus("fileStatus", "SENT", "green");
    toast("File sent successfully.", "success");
  } catch (error) {
    setModuleStatus("fileStatus", "FAILED", "red");
    toast(error.message, "error");
    logEvent("file_send_failed", { reason: error.message }, "error");
  } finally {
    state.outgoingFile = null;
    setTimeout(() => $("#fileProgress")?.classList.add("hidden"), 800);
  }
}

function showFileOffer(message) {
  state.incomingFile = {
    id: message.transferId,
    name: message.name,
    mime: message.mime,
    size: message.size,
    totalChunks: message.totalChunks,
    chunks: new Array(message.totalChunks),
    received: new Set(),
    receivedBytes: 0,
    accepted: false
  };

  $("#fileOfferName").textContent = message.name;
  $("#fileOfferMeta").textContent =
    (message.size / 1024 / 1024).toFixed(2) + " MB · explicit approval required";
  $("[data-action='save-file']").classList.add("hidden");
  $("[data-action='reject-file']").classList.remove("hidden");
  $("[data-action='accept-file']").classList.remove("hidden");
  $("#fileOffer").classList.remove("hidden");
  setModuleStatus("fileStatus", "OFFER", "amber");
}

function acceptFile() {
  const incoming = state.incomingFile;
  if (!incoming || !state.session || !state.peerConnected) return;

  incoming.accepted = true;
  state.session.send("file-transfer", {
    type: "file_accept",
    transferId: incoming.id
  });

  $("#fileOffer").classList.add("hidden");
  updateFileProgress("Receiving " + incoming.name, 0);
  setModuleStatus("fileStatus", "RECEIVING", "amber");
}

function rejectFile() {
  const incoming = state.incomingFile;
  if (!incoming || !state.session) return;

  state.session.send("file-transfer", {
    type: "file_reject",
    transferId: incoming.id
  });

  state.incomingFile = null;
  $("#fileOffer").classList.add("hidden");
  setModuleStatus("fileStatus", "READY");
  toast("File offer rejected.", "info");
}

function completeIncomingFile() {
  const incoming = state.incomingFile;
  if (!incoming || !incoming.accepted) return;

  if (
    incoming.received.size !== incoming.totalChunks ||
    incoming.receivedBytes > incoming.size
  ) {
    setModuleStatus("fileStatus", "FAILED", "red");
    toast("The received file was incomplete.", "error");
    return;
  }

  const blob = new Blob(incoming.chunks, {
    type: incoming.mime || "application/octet-stream"
  });

  if (blob.size !== incoming.size) {
    setModuleStatus("fileStatus", "FAILED", "red");
    toast("The received file size did not match the offer.", "error");
    return;
  }

  const url = URL.createObjectURL(blob);
  const safeName = incoming.name.replace(/[\\/:*?"<>|]/g, "_") || "download";

  state.completedFile = {
    url,
    name: safeName
  };
  state.incomingFile = null;

  $("#fileOfferName").textContent = safeName;
  $("#fileOfferMeta").textContent = "Transfer complete · click Save to download";
  $("#fileOffer").classList.remove("hidden");
  $("[data-action='reject-file']").classList.add("hidden");
  $("[data-action='accept-file']").classList.add("hidden");
  $("[data-action='save-file']").classList.remove("hidden");

  setModuleStatus("fileStatus", "RECEIVED", "green");
  updateFileProgress("Received " + safeName, 100);
  toast("File received. Save it from the transfer panel.", "success");
}

function sendChatMessage() {
  if (!state.session || !state.peerConnected) {
    toast("Connect to a peer before chatting.", "info");
    return;
  }

  const input = $("#chatInput");
  const text = input.value.trim();
  if (!text) return;

  const message = {
    type: "chat_message",
    messageId: transferId(),
    text,
    sentAt: Date.now()
  };

  if (!validateChatMessage(message)) {
    toast("That message is not valid.", "error");
    return;
  }

  if (!state.session.send("chat", message)) {
    toast("The chat channel is not available.", "error");
    return;
  }

  addChatMessage(text, "me");
  input.value = "";
}

function sendCapabilities(session) {
  const message = {
    type: "capabilities",
    screen: typeof navigator.mediaDevices?.getDisplayMedia === "function",
    dataChannels: true,
    clipboard: Boolean(navigator.clipboard),
    fileTransfer: true,
    chat: true,
    nativeInput: Boolean(state.nativeAgent?.capabilities?.nativeInput)
  };

  if (validateTelemetryMessage(message)) {
    session.send("telemetry", message);
  }
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
  resetModules();
  updateControlButton();
}

function setupNativeAgent(session) {
  if (state.nativeAgent) {
    try { state.nativeAgent.close(); } catch {}
    state.nativeAgent = null;
  }

  state.nativeAgentWarned = false;

  if (state.role !== "host" || !config.agentUrl) {
    setModuleStatus("nativeStatus", "N/A");
    return;
  }

  const agent = new NativeAgentClient({
    url: config.agentUrl
  });

  state.nativeAgent = agent;
  setModuleStatus("nativeStatus", "CONNECTING", "amber");

  agent.on("state", (value) => {
    if (value === "connected") {
      setModuleStatus("nativeStatus", "CONNECTED", "green");
      if ($("#nativeMessage")) {
        $("#nativeMessage").textContent =
          agent.capabilities.nativeInput
            ? "Native OS mouse/keyboard input is available."
            : "Agent connected, but native input is unavailable on this host.";
      }
      sendCapabilities(session);
    } else if (value === "connecting") {
      setModuleStatus("nativeStatus", "CONNECTING", "amber");
    } else {
      setModuleStatus("nativeStatus", "OFFLINE");
    }
  });

  agent.on("capabilities", (capabilities) => {
    if ($("#nativeMessage")) {
      $("#nativeMessage").textContent =
        capabilities.nativeInput
          ? "Native OS mouse/keyboard input is available."
          : "Agent connected, but native input is unavailable on this host.";
    }
    sendCapabilities(session);
  });

  agent.on("error", (detail) => {
    setModuleStatus("nativeStatus", "OFFLINE", "red");
    logEvent(detail.code || "native_agent_error", detail, "error");
  });

  agent.connect().catch(() => {
    setModuleStatus("nativeStatus", "OFFLINE");
  });
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
  setupNativeAgent(state.session);
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
  updateClipboardButton();
  setModuleStatus("nativeStatus", role === "host" ? "CONNECTING" : "N/A");
  $("#mobileKeyboardPanel").classList.add("hidden");
  setConnection("signaling", "amber");
  navigate("sessions");

  state.session.connect().then(() => {
    logEvent("session_ready", { role, code: state.code, mode: state.session.signalingMode });
    if (role === "controller" && !state.session.remotePeerId) {
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
    if (detail?.state === "connected") {
      setModuleStatus("chatStatus", "ONLINE", "green");
      setModuleStatus("fileStatus", "READY", "green");
      sendCapabilities(session);
    }

    if (detail?.peerId && state.role === "host" && state.session) {
      const inviteButton = $("[data-action='copy-invite']");
      if (inviteButton) inviteButton.dataset.inviteUrl = state.session.inviteUrl;
    }
  });

  session.on("channel", (detail) => {
    $("#diagData").textContent =
      detail.state === "open" ? detail.name + " open" : detail.state;

    if (detail.state === "open") {
      if (detail.name === "chat") setModuleStatus("chatStatus", "ONLINE", "green");
      if (detail.name === "file-transfer") setModuleStatus("fileStatus", "READY", "green");
      if (detail.name === "telemetry") sendCapabilities(session);
    }
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
      const forwarded =
        state.nativeAgent?.connected &&
        state.nativeAgent.capabilities.nativeInput &&
        state.nativeAgent.sendInput(message);

      if (
        state.nativeAgent?.connected &&
        state.nativeAgent.capabilities.nativeInput &&
        !forwarded
      ) {
        logEvent("native_input_send_failed", { type: message.type }, "error");
      } else if (
        !state.nativeAgentWarned &&
        (!state.nativeAgent?.connected ||
          !state.nativeAgent.capabilities.nativeInput)
      ) {
        state.nativeAgentWarned = true;
        toast(
          "Control is granted, but no native host agent is connected. Browser control cannot operate the PC operating system.",
          "info"
        );
        setModuleStatus("nativeStatus", "REQUIRED", "amber");
      }

      logEvent("input_received", { type: message.type });
      return;
    }

    if (channel === "clipboard") {
      if (state.role === "host") {
        if (!state.shareClipboard && !state.controlGranted) {
          logEvent("clipboard_rejected_no_consent", {}, "error");
          return;
        }

        if (!navigator.clipboard) {
          toast("Host clipboard API is unavailable.", "error");
        } else {
          navigator.clipboard.writeText(message.text)
            .then(() => toast("Clipboard text copied to the host browser.", "success"))
            .catch(() => toast("Host clipboard permission was unavailable.", "error"));
        }
      } else {
        state.incomingClipboard = message.text;
        updateClipboardButton();
        toast("Host sent clipboard text. Press Clipboard to copy it locally.", "info");
      }

      logEvent("clipboard_message_received", {
        characters: typeof message.text === "string" ? message.text.length : 0
      });
      return;
    }

    if (channel === "chat") {
      if (!validateChatMessage(message)) return;
      addChatMessage(message.text, "peer");
      return;
    }

    if (channel === "telemetry") {
      if (!validateTelemetryMessage(message)) return;

      if (message.type === "capabilities") {
        state.peerCapabilities = message;
        setModuleStatus("chatStatus", message.chat ? "ONLINE" : "LIMITED", message.chat ? "green" : "amber");
        setModuleStatus("fileStatus", message.fileTransfer ? "READY" : "UNSUPPORTED", message.fileTransfer ? "green" : "amber");
      }
      return;
    }

    if (channel === "file-transfer") {
      if (!validateFileTransferMessage(message)) return;

      if (message.type === "file_offer") {
        if (state.incomingFile) {
          state.session?.send("file-transfer", {
            type: "file_reject",
            transferId: message.transferId
          });
          return;
        }

        showFileOffer(message);
        toast("Incoming file: " + message.name, "info");
        return;
      }

      if (message.type === "file_accept") {
        if (state.outgoingFile?.id === message.transferId) {
          state.outgoingFile.accepted = true;
          void sendOutgoingFile();
        }
        return;
      }

      if (message.type === "file_reject") {
        if (state.outgoingFile?.id === message.transferId) {
          state.outgoingFile = null;
          $("#fileProgress").classList.add("hidden");
          setModuleStatus("fileStatus", "READY");
          toast("Peer rejected the file.", "info");
        }
        return;
      }

      const incoming = state.incomingFile;
      if (!incoming || incoming.id !== message.transferId || !incoming.accepted) return;

      if (message.type === "file_chunk") {
        if (
          incoming.received.has(message.index) ||
          message.index >= incoming.totalChunks
        ) {
          return;
        }

        let bytes;
        try {
          bytes = base64ToBytes(message.data);
        } catch {
          setModuleStatus("fileStatus", "FAILED", "red");
          logEvent("file_chunk_decode_failed", {}, "error");
          return;
        }

        incoming.received.add(message.index);
        incoming.chunks[message.index] = bytes;
        incoming.receivedBytes += bytes.byteLength;

        if (incoming.receivedBytes > incoming.size) {
          setModuleStatus("fileStatus", "FAILED", "red");
          state.incomingFile = null;
          toast("Incoming file exceeded its declared size.", "error");
          return;
        }

        updateFileProgress(
          "Receiving " + incoming.name,
          (incoming.received.size / incoming.totalChunks) * 100
        );
        return;
      }

      if (message.type === "file_complete") {
        completeIncomingFile();
      }
      return;
    }
  });

  session.on("state", (value) => {
    if (value === "connected" || value === "completed") {
      setModuleStatus("chatStatus", "ONLINE", "green");
      setModuleStatus("fileStatus", "READY", "green");
    }

    if (value === "disconnected" || value === "closed" || value === "failed") {
      setModuleStatus("chatStatus", "OFFLINE");
      if (!state.outgoingFile && !state.incomingFile) {
        setModuleStatus("fileStatus", value === "failed" ? "FAILED" : "READY");
      }
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

  if (state.nativeAgent) {
    try { state.nativeAgent.close(); } catch {}
    state.nativeAgent = null;
  }

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

    const telemetry = {
      type: "stats",
      at: Date.now(),
      rtt: stats.rtt,
      route: stats.route
    };

    if (state.peerConnected && validateTelemetryMessage(telemetry)) {
      state.session?.send("telemetry", telemetry);
    }
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
  if (
    state.role !== "controller" ||
    !state.controlGranted ||
    !validateInputMessage(message)
  ) {
    return false;
  }

  return Boolean(state.session?.send("input", message));
}

function openMobileKeyboard() {
  if (state.role !== "controller" || !state.controlGranted) {
    toast("Request and receive control before using the mobile keyboard.", "info");
    return;
  }

  $("#mobileKeyboardPanel").classList.remove("hidden");
  setTimeout(() => $("#mobileTextInput").focus(), 0);
}

function closeMobileKeyboard() {
  $("#mobileKeyboardPanel").classList.add("hidden");
  $("#mobileTextInput").blur();
}

function sendMobileText(text) {
  const value = String(text || "");
  if (!value) return;

  const message = {
    type: "text_input",
    text: value,
    timestamp: Date.now()
  };

  if (!sendInput(message)) {
    toast("The mobile keyboard message could not be sent.", "error");
    return;
  }

  $("#mobileTextInput").value = "";
}

function sendQuickKey(key, code) {
  if (state.role !== "controller" || !state.controlGranted) return;

  const down = {
    type: "keyboard",
    key,
    code,
    action: "down",
    modifiers: [],
    timestamp: Date.now()
  };

  const up = {
    ...down,
    action: "up",
    timestamp: Date.now()
  };

  sendInput(down);
  sendInput(up);
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
    state.incomingClipboard = null;
    $("[data-role]").forEach((el) => el.classList.toggle("selected", el === button));
    $("#hostForm").classList.toggle("hidden", state.role !== "host");
    $("#controllerForm").classList.toggle("hidden", state.role !== "controller");
    updateControlButton();
    updateClipboardButton();
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

  $("[data-action='mobile-keyboard']").addEventListener("click", openMobileKeyboard);
  $("[data-action='close-keyboard']").addEventListener("click", closeMobileKeyboard);
  $("[data-action='send-mobile-text']").addEventListener("click", () => {
    sendMobileText($("#mobileTextInput").value);
  });
  $("#mobileTextInput").addEventListener("input", (event) => {
    const value = event.target.value;
    if (value) sendMobileText(value);
  });
  $(".quick-key-row [data-mobile-key]").forEach((button) => {
    button.addEventListener("click", () => {
      sendQuickKey(button.dataset.mobileKey, button.dataset.mobileCode);
    });
  });

  $("[data-action='send-file']").addEventListener("click", () => {
    if (!state.session || !state.peerConnected) {
      toast("Connect to a peer before sending a file.", "info");
      return;
    }
    $("#fileInput").click();
  });

  $("#fileInput").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void sendFile(file);
  });

  $("[data-action='accept-file']").addEventListener("click", acceptFile);
  $("[data-action='reject-file']").addEventListener("click", rejectFile);
  $("[data-action='save-file']").addEventListener("click", () => {
    if (!state.completedFile) return;

    const anchor = document.createElement("a");
    anchor.href = state.completedFile.url;
    anchor.download = state.completedFile.name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    URL.revokeObjectURL(state.completedFile.url);
    state.completedFile = null;
    $("[data-action='save-file']").classList.add("hidden");
    $("[data-action='reject-file']").classList.remove("hidden");
    setModuleStatus("fileStatus", "READY", "green");
    $("#fileOffer").classList.add("hidden");
    setTimeout(() => $("#fileProgress")?.classList.add("hidden"), 500);
  });

  $("[data-action='send-chat']").addEventListener("click", sendChatMessage);
  $("#chatInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendChatMessage();
    }
  });

  $("[data-action='copy-text']").addEventListener("click", () => {
    if (!state.session || !state.peerConnected) {
      toast("Connect to a peer first.", "info");
      return;
    }

    if (
      state.role === "controller" &&
      state.incomingClipboard !== null
    ) {
      if (!navigator.clipboard) {
        toast("Clipboard permission was unavailable.", "error");
        return;
      }

      navigator.clipboard.writeText(state.incomingClipboard)
        .then(() => {
          state.incomingClipboard = null;
          updateClipboardButton();
          toast("Host clipboard copied locally.", "success");
        })
        .catch(() => toast("Clipboard permission was unavailable.", "error"));
      return;
    }

    if (!navigator.clipboard) {
      toast("Clipboard permission was unavailable.", "error");
      return;
    }

    if (!state.shareClipboard && !state.controlGranted) {
      toast("Clipboard sharing requires host approval.", "info");
      return;
    }

    navigator.clipboard.readText().then((text) => {
      if (new TextEncoder().encode(text).byteLength > 100 * 1024) {
        toast("Clipboard text is too large.", "error");
        return;
      }

      const sent = state.session?.send("clipboard", {
        type: "clipboard_text",
        text
      });

      if (sent) {
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
  $("#remoteVideo").addEventListener("pointerdown", (event) => {
    try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch {}
    sendInput({
      type: "mouse_button",
      button: event.button === 2 ? "right" : event.button === 1 ? "middle" : "left",
      action: "down",
      timestamp: Date.now()
    });
  });
  $("#remoteVideo").addEventListener("pointercancel", (event) => {
    try { event.currentTarget.releasePointerCapture?.(event.pointerId); } catch {}
  });
  $("#remoteVideo").addEventListener("pointerup", (event) => {
    try { event.currentTarget.releasePointerCapture?.(event.pointerId); } catch {}
    sendInput({
      type: "mouse_button",
      button: event.button === 2 ? "right" : event.button === 1 ? "middle" : "left",
      action: "up",
      timestamp: Date.now()
    });
  });
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
