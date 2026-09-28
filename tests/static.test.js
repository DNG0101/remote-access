import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL("../" + path, import.meta.url), "utf8");

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
});

test("host establishes WebRTC before optional control consent", () => {
  const rtc = read("webrtc.js");
  assert.match(rtc, /kind: "offer"/);
  assert.match(rtc, /kind: "answer"/);
  assert.match(rtc, /kind: "candidate"/);
  assert.match(rtc, /await this\.ensurePeerConnection\(true\)/);
  assert.match(rtc, /connectionstatechange/);
  assert.match(rtc, /connectionState/);
});

test("public client is configured for a WSS signaling endpoint", () => {
  const config = read("config.js");
  assert.match(config, /wss:\/\//);
  assert.match(config, /signalingUrl/);
});
