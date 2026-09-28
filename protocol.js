export const PROTOCOL_VERSION = "1.1.0";

export const CHANNELS = Object.freeze([
  "control",
  "input",
  "clipboard",
  "file-transfer",
  "telemetry",
  "chat"
]);

const SIGNAL_KINDS = new Set(["offer", "answer", "candidate", "leave", "error"]);
const INPUT_TYPES = new Set(["mouse_move", "mouse_button", "scroll", "keyboard"]);
const CONTROL_TYPES = new Set([
  "control_request",
  "control_decision",
  "control_revoked",
  "capabilities",
  "clipboard_text"
]);

const MAX_SIGNAL_BYTES = 256 * 1024;
const MAX_CHANNEL_BYTES = 256 * 1024;
const MAX_CLIPBOARD_BYTES = 100 * 1024;
const MAX_PENDING_CANDIDATES = 64;
const MAX_PENDING_MESSAGES = 20;

const encoder = new TextEncoder();

const byteLength = (value) => encoder.encode(String(value)).byteLength;
const isObject = (value) => Boolean(
  value &&
  typeof value === "object" &&
  !Array.isArray(value)
);

const validPeerId = (value) =>
  typeof value === "string" &&
  /^[A-Za-z0-9_-]{8,96}$/.test(value);

const validRole = (value) => value === "host" || value === "controller";

export function makePeerId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Secure random APIs are unavailable.");
  }

  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export function generateSessionCode() {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Secure random APIs are unavailable.");
  }

  const upperBound = Math.floor(0x100000000 / 1000000) * 1000000;
  const value = new Uint32Array(1);

  do {
    globalThis.crypto.getRandomValues(value);
  } while (value[0] >= upperBound);

  return String(value[0] % 1000000).padStart(6, "0");
}

export function normalizeSessionCode(value) {
  return String(value ?? "").replace(/\D/g, "").slice(0, 6);
}

export function isRecentTimestamp(value, maxAgeMs = 120000) {
  return Number.isFinite(value) && Math.abs(Date.now() - value) <= maxAgeMs;
}

export function validateSignalMessage(message) {
  if (!isObject(message)) {
    return { ok: false, reason: "SIGNAL_NOT_OBJECT" };
  }

  if (
    message.sys === "roster" &&
    typeof message.roomId === "string" &&
    /^\d{6}$/.test(message.roomId) &&
    Array.isArray(message.roster) &&
    message.roster.length <= 16 &&
    message.roster.every((peerId) =>
      typeof peerId === "string" &&
      peerId.length > 0 &&
      peerId.length <= 96
    )
  ) {
    if (byteLength(JSON.stringify(message)) > MAX_SIGNAL_BYTES) {
      return { ok: false, reason: "SIGNAL_TOO_LARGE" };
    }
    return { ok: true };
  }

  if (message.server === true && message.kind === "error") {
    if (
      typeof message.codeName !== "string" ||
      message.codeName.length < 1 ||
      message.codeName.length > 80
    ) {
      return { ok: false, reason: "SIGNAL_ERROR_CODE_INVALID" };
    }

    if (
      message.message != null &&
      (typeof message.message !== "string" || message.message.length > 500)
    ) {
      return { ok: false, reason: "SIGNAL_ERROR_MESSAGE_INVALID" };
    }

    if (byteLength(JSON.stringify(message)) > MAX_SIGNAL_BYTES) {
      return { ok: false, reason: "SIGNAL_TOO_LARGE" };
    }

    return { ok: true };
  }

  if (
    typeof message.roomId !== "string" ||
    !/^\d{6}$/.test(message.roomId)
  ) {
    return { ok: false, reason: "SIGNAL_ROOM_INVALID" };
  }

  if (!validPeerId(message.from)) {
    return { ok: false, reason: "SIGNAL_PEER_ID_INVALID" };
  }

  if (message.to != null && !validPeerId(message.to)) {
    return { ok: false, reason: "SIGNAL_TARGET_INVALID" };
  }

  if (!Number.isFinite(Number(message.sentAt)) ||
      !isRecentTimestamp(Number(message.sentAt))) {
    return { ok: false, reason: "SIGNAL_TIMESTAMP_INVALID" };
  }

  const isAnnouncement = message.announce === true;
  if (!isAnnouncement && !SIGNAL_KINDS.has(message.kind)) {
    return { ok: false, reason: "SIGNAL_KIND_UNSUPPORTED" };
  }

  if (isAnnouncement) {
    if (!validRole(message.role)) {
      return { ok: false, reason: "SIGNAL_ANNOUNCE_ROLE_INVALID" };
    }
  }

  if (message.kind === "offer" || message.kind === "answer") {
    const description = message.description;
    if (
      !isObject(description) ||
      description.type !== message.kind ||
      typeof description.sdp !== "string" ||
      !description.sdp.length ||
      byteLength(description.sdp) > 200 * 1024
    ) {
      return { ok: false, reason: "SIGNAL_DESCRIPTION_INVALID" };
    }
  }

  if (message.kind === "candidate") {
    const candidate = message.candidate;
    if (
      !isObject(candidate) ||
      typeof candidate.candidate !== "string" ||
      byteLength(candidate.candidate) > 16 * 1024
    ) {
      return { ok: false, reason: "SIGNAL_CANDIDATE_INVALID" };
    }

    if (candidate.sdpMid != null && typeof candidate.sdpMid !== "string") {
      return { ok: false, reason: "SIGNAL_SDP_MID_INVALID" };
    }

    if (
      candidate.sdpMLineIndex != null &&
      !Number.isInteger(candidate.sdpMLineIndex)
    ) {
      return { ok: false, reason: "SIGNAL_SDP_LINE_INVALID" };
    }

    if (
      candidate.usernameFragment != null &&
      typeof candidate.usernameFragment !== "string"
    ) {
      return { ok: false, reason: "SIGNAL_USERNAME_FRAGMENT_INVALID" };
    }
  }

  if (message.kind === "error") {
    if (
      typeof message.codeName !== "string" ||
      message.codeName.length < 1 ||
      message.codeName.length > 80
    ) {
      return { ok: false, reason: "SIGNAL_ERROR_CODE_INVALID" };
    }

    if (
      message.message != null &&
      (typeof message.message !== "string" || message.message.length > 500)
    ) {
      return { ok: false, reason: "SIGNAL_ERROR_MESSAGE_INVALID" };
    }
  }

  if (byteLength(JSON.stringify(message)) > MAX_SIGNAL_BYTES) {
    return { ok: false, reason: "SIGNAL_TOO_LARGE" };
  }

  return { ok: true };
}

export function validateInputMessage(message) {
  if (
    !isObject(message) ||
    !INPUT_TYPES.has(message.type) ||
    !isRecentTimestamp(message.timestamp, 120000)
  ) {
    return false;
  }

  if (message.type === "mouse_move") {
    return (
      Number.isFinite(message.x) &&
      Number.isFinite(message.y) &&
      message.x >= 0 &&
      message.x <= 1 &&
      message.y >= 0 &&
      message.y <= 1 &&
      typeof message.monitorId === "string" &&
      message.monitorId.length > 0 &&
      message.monitorId.length <= 128
    );
  }

  if (message.type === "mouse_button") {
    return (
      ["left", "middle", "right"].includes(message.button) &&
      ["down", "up", "double"].includes(message.action)
    );
  }

  if (message.type === "scroll") {
    return (
      Number.isFinite(message.deltaX) &&
      Number.isFinite(message.deltaY) &&
      Math.abs(message.deltaX) <= 10000 &&
      Math.abs(message.deltaY) <= 10000
    );
  }

  return (
    typeof message.key === "string" &&
    message.key.length > 0 &&
    message.key.length <= 64 &&
    typeof message.code === "string" &&
    message.code.length > 0 &&
    message.code.length <= 64 &&
    ["down", "up"].includes(message.action) &&
    Array.isArray(message.modifiers) &&
    message.modifiers.length <= 4 &&
    message.modifiers.every((value) =>
      ["CTRL", "ALT", "SHIFT", "META"].includes(value)
    )
  );
}

export function validateControlMessage(message) {
  if (
    !isObject(message) ||
    !CONTROL_TYPES.has(message.type) ||
    byteLength(JSON.stringify(message)) > MAX_CHANNEL_BYTES
  ) {
    return false;
  }

  if (message.type === "control_request") {
    return (
      typeof message.requestId === "string" &&
      /^[A-Za-z0-9_-]{8,64}$/.test(message.requestId) &&
      isRecentTimestamp(message.requestedAt, 30000)
    );
  }

  if (message.type === "control_decision") {
    return (
      typeof message.requestId === "string" &&
      /^[A-Za-z0-9_-]{8,64}$/.test(message.requestId) &&
      typeof message.granted === "boolean"
    );
  }

  if (message.type === "control_revoked") {
    return (
      message.reason == null ||
      (typeof message.reason === "string" && message.reason.length <= 120)
    );
  }

  if (message.type === "capabilities") {
    return (
      typeof message.controlAllowed === "boolean" &&
      typeof message.clipboard === "boolean" &&
      typeof message.screen === "boolean"
    );
  }

  return (
    typeof message.text === "string" &&
    byteLength(message.text) <= MAX_CLIPBOARD_BYTES
  );
}

export function validateDataChannelMessage(channel, message) {
  if (
    typeof message !== "string" ||
    byteLength(message) > MAX_CHANNEL_BYTES
  ) {
    return false;
  }

  let parsed;
  try {
    parsed = JSON.parse(message);
  } catch {
    return false;
  }

  if (channel === "input") {
    return validateInputMessage(parsed);
  }

  if (channel === "control" || channel === "clipboard") {
    return validateControlMessage(parsed);
  }

  return isObject(parsed);
}

export function calculateBitrate(previous, current, at = Date.now()) {
  if (
    !previous ||
    !Number.isFinite(current?.bytes) ||
    !Number.isFinite(previous.bytes) ||
    !Number.isFinite(previous.at) ||
    at <= previous.at
  ) {
    return null;
  }

  const delta = current.bytes - previous.bytes;
  if (delta < 0) return null;

  return Math.round(
    (delta * 8) / ((at - previous.at) / 1000) / 1000
  );
}

export {
  MAX_SIGNAL_BYTES,
  MAX_CHANNEL_BYTES,
  MAX_CLIPBOARD_BYTES,
  MAX_PENDING_CANDIDATES,
  MAX_PENDING_MESSAGES
};
