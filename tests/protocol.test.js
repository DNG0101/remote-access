import test from "node:test";import assert from "node:assert/strict";import { generateSessionCode, normalizeSessionCode, validateSignalMessage, validateInputMessage, validateControlMessage, validateDataChannelMessage, calculateBitrate } from "../protocol.js";\nimport { PeerSession } from "../webrtc.js";
test("session codes are secure six-digit values",()=>{const c=generateSessionCode();assert.match(c,/^\d{6}$/);assert.equal(normalizeSessionCode("12a 34-5678"),"123456");});
test("input validation rejects stale and out-of-range events",()=>{assert.equal(validateInputMessage({type:"mouse_move",timestamp:Date.now(),x:.5,y:.5,monitorId:"m1"}),true);assert.equal(validateInputMessage({type:"mouse_move",timestamp:Date.now(),x:1.2,y:.5,monitorId:"m1"}),false);assert.equal(validateInputMessage({type:"mouse_move",timestamp:Date.now()-300000,x:.5,y:.5,monitorId:"m1"}),false);});
test("control requests require identity and freshness",()=>{const id="550e8400-e29b-41d4-a716-446655440000";assert.equal(validateControlMessage({type:"control_request",requestId:id,requestedAt:Date.now()}),true);assert.equal(validateControlMessage({type:"control_request",requestId:"bad",requestedAt:Date.now()}),false);assert.equal(validateControlMessage({type:"control_request",requestId:id,requestedAt:Date.now()-60000}),false);});
test("data channel validation rejects malformed input",()=>{assert.equal(validateDataChannelMessage("input",JSON.stringify({type:"mouse_move",timestamp:Date.now(),x:.5,y:.5,monitorId:"m"})),true);assert.equal(validateDataChannelMessage("input",JSON.stringify({type:"mouse_move",timestamp:Date.now(),x:2,y:.5,monitorId:"m"})),false);assert.equal(validateDataChannelMessage("control","not-json"),false);});
test("bitrate is calculated from byte deltas",()=>{assert.equal(calculateBitrate({bytes:1000,at:1000},{bytes:2000},2000),8);assert.equal(calculateBitrate({bytes:1000,at:1000},{bytes:900},2000),null);});

test("native signaling envelopes match the live room protocol", () => {
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const now = Date.now();

  assert.equal(
    validateSignalMessage({
      roomId: "123456",
      from: id,
      role: "host",
      announce: true,
      sentAt: now
    }).ok,
    true
  );

  assert.equal(
    validateSignalMessage({
      roomId: "123456",
      from: id,
      to: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      kind: "offer",
      description: {
        type: "offer",
        sdp: "v=0"
      },
      sentAt: now
    }).ok,
    true
  );

  assert.equal(
    validateSignalMessage({
      type: "join",
      code: "123456",
      from: "host",
      peerId: id,
      at: now
    }).ok,
    false
  );
});

test("PeerSession can queue a data-channel message before the channel opens", () => {
  const previousMediaStream = globalThis.MediaStream;

  globalThis.MediaStream = class {
    constructor() {
      this.tracks = [];
    }
    getTracks() {
      return this.tracks;
    }
    addTrack(track) {
      this.tracks.push(track);
    }
  };

  try {
    const session = new PeerSession({
      code: "123456",
      role: "controller",
      signalingUrl: "ws://127.0.0.1:8787"
    });

    assert.equal(
      session.send("control", {
        type: "control_request",
        requestId: "req-test-123456",
        requestedAt: Date.now()
      }),
      true
    );
    assert.equal(
      session.pendingMessages.get("control").length,
      1
    );
  } finally {
    if (previousMediaStream === undefined) {
      delete globalThis.MediaStream;
    } else {
      globalThis.MediaStream = previousMediaStream;
    }
  }
});


test("PeerSession discovers a peer from roster-style signaling", async () => {
  const previousMediaStream = globalThis.MediaStream;

  globalThis.MediaStream = class {
    constructor() {
      this.tracks = [];
    }
    getTracks() {
      return this.tracks;
    }
    addTrack(track) {
      this.tracks.push(track);
    }
  };

  try {
    const session = new PeerSession({
      code: "123456",
      role: "controller",
      signalingUrl: "ws://127.0.0.1:8787"
    });

    let joinedPeer = "";
    session.on("message", ({ channel, data }) => {
      if (channel === "system" && data.type === "peer_joined") {
        joinedPeer = data.peerId;
      }
    });

    await session.handleSignal({
      sys: "roster",
      roomId: "123456",
      roster: [session.peerId, "host-peer_1"],
    });

    assert.equal(joinedPeer, "host-peer_1");
    assert.equal(session.remotePeerId, "host-peer_1");
    assert.equal(session.remoteRole, "host");

    session.closePeerConnection();
  } finally {
    if (previousMediaStream === undefined) {
      delete globalThis.MediaStream;
    } else {
      globalThis.MediaStream = previousMediaStream;
    }
  }
});
