import { validateInputMessage } from "./protocol.js";

const EVENTS = ["state", "capabilities", "error"];

export class NativeAgentClient extends EventTarget {
  constructor({ url = "" } = {}) {
    super();
    this.url = url;
    this.socket = null;
    this.connected = false;
    this.capabilities = {
      nativeInput: false,
      clipboard: false,
      files: false,
      monitors: false
    };
    this.connectPromise = null;
    this.closed = false;
    this.helloTimeout = null;
  }

  on(name, fn) {
    if (!EVENTS.includes(name)) {
      throw new Error("Unsupported agent event: " + name);
    }
    this.addEventListener(name, (event) => fn(event.detail));
    return this;
  }

  emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }

  async connect() {
    if (this.closed) return false;
    if (this.connected) return true;
    if (this.connectPromise) return this.connectPromise;

    if (!/^wss?:\/\//i.test(this.url)) {
      throw new Error("The native agent URL must use ws:// or wss://.");
    }

    this.connectPromise = new Promise((resolve) => {
      let socket;
      let settled = false;

      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (this.helloTimeout) {
          clearTimeout(this.helloTimeout);
          this.helloTimeout = null;
        }
        resolve(value);
      };

      try {
        socket = new WebSocket(this.url);
      } catch (error) {
        this.emit("error", {
          code: "AGENT_CREATE_FAILED",
          message: error.message
        });
        finish(false);
        return;
      }

      this.socket = socket;
      this.emit("state", "connecting");

      this.helloTimeout = setTimeout(() => {
        try { socket.close(); } catch {}
        this.emit("error", {
          code: "AGENT_TIMEOUT",
          message: "The native host agent did not complete its handshake."
        });
        finish(false);
      }, 5000);

      socket.onopen = () => {
        try {
          socket.send(JSON.stringify({
            type: "hello",
            protocol: "1.1.0",
            client: "p2p-desk-browser"
          }));
        } catch (error) {
          this.emit("error", {
            code: "AGENT_HELLO_FAILED",
            message: error.message
          });
          finish(false);
        }
      };

      socket.onmessage = (event) => {
        if (typeof event.data !== "string" || event.data.length > 32 * 1024) {
          this.emit("error", {
            code: "AGENT_MESSAGE_INVALID",
            message: "The native agent sent an invalid message."
          });
          return;
        }

        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          this.emit("error", {
            code: "AGENT_MESSAGE_INVALID",
            message: "The native agent sent invalid JSON."
          });
          return;
        }

        if (message.type === "hello_ack") {
          this.capabilities = {
            nativeInput: Boolean(message.nativeInput),
            clipboard: Boolean(message.clipboard),
            files: Boolean(message.files),
            monitors: Boolean(message.monitors)
          };
          this.connected = true;
          this.emit("capabilities", this.capabilities);
          this.emit("state", "connected");
          finish(true);
          return;
        }

        if (message.type === "error") {
          this.emit("error", {
            code: message.code || "AGENT_ERROR",
            message: message.message || "The native host agent rejected the request."
          });
          return;
        }
      };

      socket.onerror = () => {
        this.emit("error", {
          code: "AGENT_UNAVAILABLE",
          message: "The native host agent is unavailable."
        });
        finish(false);
      };

      socket.onclose = () => {
        this.connected = false;
        this.emit("state", this.closed ? "closed" : "disconnected");
        finish(false);
      };
    });

    const result = await this.connectPromise;
    this.connectPromise = null;
    return result;
  }

  sendInput(message) {
    if (
      !this.connected ||
      !this.capabilities.nativeInput ||
      !validateInputMessage(message) ||
      this.socket?.readyState !== WebSocket.OPEN
    ) {
      return false;
    }

    try {
      this.socket.send(JSON.stringify({
        type: "input",
        message
      }));
      return true;
    } catch (error) {
      this.emit("error", {
        code: "AGENT_SEND_FAILED",
        message: error.message
      });
      return false;
    }
  }

  close() {
    this.closed = true;
    this.connected = false;
    try { this.socket?.close(); } catch {}
    this.socket = null;
    this.emit("state", "closed");
  }
}
