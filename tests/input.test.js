import test from "node:test";
import assert from "node:assert/strict";
import { NativeAgentClient } from "../agent-client.js";

class MockWebSocket {
  static OPEN = 1;

  constructor() {
    this.readyState = 0;
    this.sent = [];
    MockWebSocket.instance = this;
  }

  send(value) {
    this.sent.push(JSON.parse(value));
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  receive(message) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

test("native agent forwards every validated pointer and keyboard combination", async () => {
  const previous = globalThis.WebSocket;
  globalThis.WebSocket = MockWebSocket;

  try {
    const client = new NativeAgentClient({
      url: "ws://127.0.0.1:17878"
    });
    const connecting = client.connect();
    const socket = MockWebSocket.instance;
    socket.open();
    socket.receive({
      type: "hello_ack",
      nativeInput: true,
      clipboard: false,
      files: false,
      monitors: true
    });
    assert.equal(await connecting, true);

    const timestamp = Date.now();
    const inputs = [
      { type: "mouse_move", timestamp, x: 0, y: 1, monitorId: "browser-display" },
      { type: "mouse_button", timestamp, button: "left", action: "down" },
      { type: "mouse_button", timestamp, button: "left", action: "up" },
      { type: "mouse_button", timestamp, button: "right", action: "double", x: 0.5, y: 0.5 },
      { type: "scroll", timestamp, deltaX: -3, deltaY: 120 },
      { type: "keyboard", timestamp, key: "A", code: "KeyA", action: "down", modifiers: ["SHIFT"] },
      { type: "keyboard", timestamp, key: "A", code: "KeyA", action: "up", modifiers: ["SHIFT"] },
      { type: "text_input", timestamp, text: "hello" }
    ];

    for (const message of inputs) {
      assert.equal(client.sendInput(message), true);
    }

    assert.deepEqual(
      socket.sent.slice(1).map((packet) => packet.message),
      inputs
    );
  } finally {
    if (previous === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = previous;
  }
});
