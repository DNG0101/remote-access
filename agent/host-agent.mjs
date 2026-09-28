import http from "node:http";
import { WebSocketServer } from "ws";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { validateInputMessage } from "../protocol.js";

const execFileAsync = promisify(execFile);
const PORT = Number(process.env.P2P_DESK_AGENT_PORT || 17878);
const ALLOWED_ORIGINS = (process.env.P2P_DESK_AGENT_ORIGINS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

function originAllowed(origin) {
  if (!ALLOWED_ORIGINS.length) {
    return /^https?:\/\/localhost(?::\d+)?$/.test(origin) ||
      /^https?:\/\/127\.0\.0\.1(?::\d+)?$/.test(origin);
  }

  return ALLOWED_ORIGINS.includes(origin);
}

function send(ws, message) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

async function commandExists(command) {
  try {
    await execFileAsync(
      process.platform === "win32" ? "where" : "which",
      [command]
    );
    return true;
  } catch {
    return false;
  }
}

function keyCodeMap(code) {
  const direct = new Map([
    ["Enter", "RETURN"],
    ["Escape", "ESC"],
    ["Tab", "TAB"],
    ["Backspace", "BACKSPACE"],
    ["Delete", "DELETE"],
    ["Insert", "INSERT"],
    ["Home", "HOME"],
    ["End", "END"],
    ["PageUp", "PAGEUP"],
    ["PageDown", "PAGEDOWN"],
    ["ArrowUp", "UP"],
    ["ArrowDown", "DOWN"],
    ["ArrowLeft", "LEFT"],
    ["ArrowRight", "RIGHT"],
    ["Space", "SPACE"],
  ]);

  if (direct.has(code)) return direct.get(code);

  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return "NUM" + code.slice(6);
  if (/^F(?:[1-9]|1[0-2])$/.test(code)) return code;

  return null;
}

class WindowsInputBridge {
  constructor() {
    this.child = null;
    this.ready = false;
  }

  start() {
    if (process.platform !== "win32") return false;

    const script = fileURLToPath(
      new URL("./windows-input.ps1", import.meta.url)
    );
    this.child = spawn("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script
    ], {
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.child.stdout.on("data", () => {});
    this.child.stderr.on("data", (data) => {
      process.stderr.write("[agent/windows] " + data.toString());
    });
    this.child.on("exit", () => {
      this.ready = false;
    });

    this.ready = true;
    return true;
  }

  send(message) {
    if (!this.ready || !this.child?.stdin?.writable) return false;

    try {
      this.child.stdin.write(JSON.stringify(message) + "\n");
      return true;
    } catch {
      return false;
    }
  }

  async stop() {
    this.ready = false;
    try {
      this.child?.stdin.end();
    } catch {}
    this.child = null;
  }
}

const windows = new WindowsInputBridge();
const windowsReady = windows.start();

async function linuxInput(message) {
  if (!(await commandExists("xdotool"))) return false;

  if (message.type === "mouse_move") {
    const width = 1920;
    const height = 1080;
    await execFileAsync("xdotool", [
      "mousemove",
      String(Math.round(message.x * width)),
      String(Math.round(message.y * height))
    ]);
    return true;
  }

  if (message.type === "mouse_button") {
    const button = { left: "1", middle: "2", right: "3" }[message.button];
    if (!button) return false;

    if (message.action === "double") {
      await execFileAsync("xdotool", ["click", "--repeat", "2", button]);
    } else {
      await execFileAsync("xdotool", [
        message.action === "down" ? "mousedown" : "mouseup",
        button
      ]);
    }
    return true;
  }

  if (message.type === "scroll") {
    const clicks = Math.max(
      -20,
      Math.min(20, Math.round(-message.deltaY / 40))
    );
    if (clicks) {
      await execFileAsync("xdotool", [
        "click",
        "--repeat",
        String(Math.abs(clicks)),
        "--delay",
        "1",
        clicks > 0 ? "4" : "5"
      ]);
    }
    return true;
  }

  if (message.type === "keyboard") {
    const key = keyCodeMap(message.code);
    if (!key) return false;
    await execFileAsync("xdotool", [
      message.action === "down" ? "keydown" : "keyup",
      key
    ]);
    return true;
  }

  return false;
}

async function executeInput(message) {
  if (!validateInputMessage(message)) return false;

  if (process.platform === "win32") {
    return windows.send(message);
  }

  if (process.platform === "linux") {
    return linuxInput(message);
  }

  return false;
}

function capabilities() {
  if (process.platform === "win32") {
    return {
      nativeInput: windowsReady && windows.ready,
      clipboard: true,
      files: false,
      monitors: true
    };
  }

  return {
    nativeInput: false,
    clipboard: false,
    files: false,
    monitors: false
  };
}

const server = http.createServer();
const wss = new WebSocketServer({
  server,
  maxPayload: 64 * 1024,
  perMessageDeflate: false
});

wss.on("connection", (ws, req) => {
  const origin = req.headers.origin || "";
  if (!originAllowed(origin)) {
    ws.close(4003, "Origin not allowed");
    return;
  }

  let authenticated = false;

  ws.on("message", async (raw) => {
    if (raw.length > 64 * 1024) {
      ws.close(4009, "Message too large");
      return;
    }

    let packet;
    try {
      packet = JSON.parse(raw.toString());
    } catch {
      send(ws, {
        type: "error",
        code: "INVALID_JSON",
        message: "Invalid JSON."
      });
      return;
    }

    if (!packet || typeof packet !== "object") return;

    if (!authenticated) {
      if (packet.type !== "hello" || packet.protocol !== "1.1.0") {
        ws.close(4004, "Handshake required");
        return;
      }

      authenticated = true;
      send(ws, {
        type: "hello_ack",
        nativeInput: capabilities().nativeInput,
        clipboard: capabilities().clipboard,
        files: capabilities().files,
        monitors: capabilities().monitors
      });
      return;
    }

    if (packet.type === "input") {
      const input = packet.message;
      if (!validateInputMessage(input)) {
        send(ws, {
          type: "error",
          code: "INVALID_INPUT",
          message: "The input event failed validation."
        });
        return;
      }

      const ok = await executeInput(input);
      if (!ok) {
        send(ws, {
          type: "error",
          code: "INPUT_UNAVAILABLE",
          message: "Native input is unavailable on this host."
        });
      }
      return;
    }

    send(ws, {
      type: "error",
      code: "UNSUPPORTED_OPERATION",
      message: "The requested native-agent operation is not implemented."
    });
  });

  ws.on("error", () => {});
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("P2P Desk native host agent listening on ws://127.0.0.1:" + PORT);
  if (!ALLOWED_ORIGINS.length) {
    console.log("Set P2P_DESK_AGENT_ORIGINS to the exact Pages origin before remote use.");
  }
});

const shutdown = async () => {
  await windows.stop();
  wss.close();
  server.close();
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
