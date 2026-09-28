import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read=(path)=>fs.readFileSync(new URL("../"+path, import.meta.url),"utf8");

test("GitHub Pages loads the pinned public PeerJS client",()=>{
  const html=read("index.html");
  assert.match(html,/cdn\.jsdelivr\.net\/npm\/peerjs@1\.5\.5\/dist\/peerjs\.min\.js/);
  assert.match(html,/data-action="copy-invite"/);
});

test("controller invite links are parsed by the client",()=>{
  const app=read("app.js");
  assert.match(app,/new URLSearchParams\(location\.search\)/);
  assert.match(app,/inviteParams\.get\("join"\)/);
  assert.match(app,/createSession\("controller", inviteCode, invitePeerId\)/);
});

test("host connection starts before control consent",()=>{
  const rtc=read("webrtc.js");
  assert.match(rtc,/type: "peer_joined"/);
  assert.match(rtc,/await this\.startHostConnection\(\)/);
  assert.match(rtc,/await this\.startHostConnection\(\)/);
assert.match(rtc,/type: "peer_joined"/);
});
