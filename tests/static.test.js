import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) =>
  fs.readFileSync(new URL("../" + path, import.meta.url), "utf8");

test("GitHub Pages loads the application without third-party runtime dependencies", () => {
  const html = read("index.html");
  assert.doesNotMatch(html, /peerjs/i);
  assert.match(html, /type="module" src="app\.js(?:\?[^"]*)?"/);
  assert.match(html, /data-action="copy-invite"/);
});

test("controller can join a session by six-digit room code", () => {
  const app = read("app.js");
  assert.match(app, /normalizeSessionCode\(code\)/);
  assert.match(app, /createSession\("controller", code\)/);
  assert.match(app, /inviteParams\.get\("code"\)/);
  assert.match(app, /createSession\("controller", inviteCode\)/);
  assert.match(app, /data-action='send-file'/);
  assert.match(app, /data-action='send-chat'/);
  assert.match(app, /data-action='save-file'/);
  assert.match(app, /validateFileTransferMessage/);
  assert.match(app, /validateTelemetryMessage/);
  assert.match(app, /NativeAgentClient/);
  assert.match(app, /data-action='mobile-keyboard'/);
  assert.match(app, /type: "text_input"/);
});

test("host establishes WebRTC before optional control consent", () => {
  const rtc = read("webrtc.js");
  assert.match(rtc, /kind: "offer"/);
  assert.match(rtc, /kind: "answer"/);
  assert.match(rtc, /kind: "candidate"/);
  assert.match(rtc, /await this\.ensurePeerConnection\(true\)/);
  assert.match(rtc, /connectionstatechange/);
  assert.match(rtc, /connectionState/);
  assert.match(rtc, /pendingMessages = new Map/);
  assert.match(rtc, /kind: "leave"/);
  assert.match(rtc, /queueNegotiation/);
  assert.match(rtc, /flushPendingMessages/);
  assert.match(rtc, /sys === "roster"/);
});

test("public client is configured for a WSS signaling endpoint", () => {
  const config = read("config.js");
  assert.match(config, /wss:\/\//);
  assert.match(config, /signalingUrl/);
  assert.match(config, /appVersion: "0\.5\.0"/);
});


test("native agent bridge is included in the browser build", () => {
  const client = read("agent-client.js");
  const agent = read("agent/host-agent.mjs");
  assert.match(client, /class NativeAgentClient/);
  assert.match(client, /type: "input"/);
  assert.match(agent, /127\.0\.0\.1/);
  assert.match(agent, /validateInputMessage/);
});
