import test from "node:test";
import assert from "node:assert/strict";
import {
  generateSessionCode,
  normalizeSessionCode,
  validateSignalMessage,
  validateInputMessage,
  validateControlMessage,
  validateDataChannelMessage,
  validateChatMessage,
  validateFileTransferMessage,
  validateTelemetryMessage,
  calculateBitrate
} from "../protocol.js";
import { PeerSession } from "../webrtc.js";
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
    session.ensurePeerConnection = async () => null;
    session.on("message", ({ channel, data }) => {
      let message = data;
      if (typeof data === "string") {
        try { message = JSON.parse(data); } catch {}
      }
      if (channel === "system" && message?.type === "peer_joined") {
        joinedPeer = message.peerId;
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


test("chat, file, and telemetry modules validate their live message shapes", () => {
  const now = Date.now();

  assert.equal(
    validateChatMessage({
      type: "chat_message",
      messageId: "chat-123456",
      text: "hello",
      sentAt: now
    }),
    true
  );

  assert.equal(
    validateFileTransferMessage({
      type: "file_offer",
      transferId: "file-123456",
      name: "test.txt",
      mime: "text/plain",
      size: 12,
      totalChunks: 1
    }),
    true
  );

  assert.equal(
    validateFileTransferMessage({
      type: "file_offer",
      transferId: "file-123456",
      name: "too-large.bin",
      mime: "application/octet-stream",
      size: 30 * 1024 * 1024,
      totalChunks: 200
    }),
    false
  );

  assert.equal(
    validateTelemetryMessage({
      type: "capabilities",
      screen: true,
      dataChannels: true,
      clipboard: true,
      fileTransfer: true,
      chat: true,
      nativeInput: false
    }),
    true
  );

  assert.equal(
    validateDataChannelMessage(
      "clipboard",
      JSON.stringify({
        type: "clipboard_text",
        text: "hello"
      })
    ),
    true
  );

  assert.equal(
    validateDataChannelMessage(
      "clipboard",
      JSON.stringify({
        type: "control_request",
        requestId: "bad-cross-channel",
        requestedAt: now
      })
    ),
    false
  );

  assert.equal(
    validateDataChannelMessage(
      "chat",
      JSON.stringify({
        type: "chat_message",
        messageId: "chat-789012",
        text: "hello",
        sentAt: now
      })
    ),
    true
  );
});


test("zero-byte files are valid transfer offers", () => {
  assert.equal(
    validateFileTransferMessage({
      type: "file_offer",
      transferId: "empty-file-1",
      name: "empty.txt",
      mime: "text/plain",
      size: 0,
      totalChunks: 0
    }),
    true
  );
});


test("mobile text-input events validate and route through the input channel", () => {
  const message = {
    type: "text_input",
    text: "Hello from Android",
    timestamp: Date.now()
  };

  assert.equal(validateInputMessage(message), true);
  assert.equal(
    validateDataChannelMessage("input", JSON.stringify(message)),
    true
  );
  assert.equal(
    validateInputMessage({
      ...message,
      text: "x".repeat(5000),
      timestamp: Date.now()
    }),
    false
  );
});
