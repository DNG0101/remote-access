# Protocol notes

Protocol version: 1.1.0.

## Session signaling

Browser and included signaling server use JSON envelopes with roomId, from, optional to, sentAt, announce and kind.

Supported signaling kinds are offer, answer, candidate, leave and error. Some public relay deployments return a roster discovery message:

```json
{"sys":"roster","roomId":"123456","roster":["peer-a","peer-b"]}
```

The browser accepts both direct announcements and roster discovery.

## WebRTC channels

| Channel | Ordering | Purpose |
|---|---|---|
| control | ordered | consent and permission decisions |
| input | unordered | normalized mouse/keyboard intents |
| clipboard | ordered | user-initiated text transfer |
| file-transfer | ordered | explicit file offers, accepts, chunks and completion |
| telemetry | ordered | capabilities and connection information |
| chat | ordered | session text messages |

## Chat

```json
{"type":"chat_message","messageId":"chat-123456","text":"hello","sentAt":1730000000000}
```

## File transfer

Sender sends file_offer. Recipient explicitly accepts or rejects it. Accepted files are transferred as base64-encoded chunks in this browser milestone, limited to 25 MB.

```json
{"type":"file_offer","transferId":"file-123456","name":"report.pdf","mime":"application/pdf","size":123456,"totalChunks":1}
```

Production native agents should use streaming/binary data channels instead of large in-memory base64 buffers.

## Capabilities

```json
{"type":"capabilities","screen":true,"dataChannels":true,"clipboard":true,"fileTransfer":true,"chat":true,"nativeInput":false}
```

Unsupported features must be reported as unsupported rather than simulated.

## Input

Pointer coordinates are normalized to 0..1. Keyboard events carry key, code, action and modifiers. Every input event has a recent timestamp.

The browser milestone validates and transports these events but does not inject them into the operating system. A native host agent is required for OS-level mouse and keyboard control.
