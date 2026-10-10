# Protocol notes

Protocol version: 2.0.0.

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

The sender first sends a JSON `file_offer` containing the filename, MIME type, exact byte size, chunk size, chunk count, protocol version, and negotiated mode. The recipient must explicitly accept or reject the offer. The browser implementation advertises `binary` and `base64`; Android currently advertises `base64` only, so the sender automatically selects the compatibility path for that peer.

```json
{"type":"file_offer","transferId":"file-123456","transferVersion":2,"mode":"binary","chunkSize":262144,"name":"report.pdf","mime":"application/pdf","size":123456,"totalChunks":1}
```

Binary mode keeps control messages as JSON and sends each file chunk as a binary frame on the ordered `file-transfer` channel. A frame contains a magic marker, version, UTF-8 transfer ID, chunk index, payload length, and payload bytes. The receiver validates every field, ignores duplicates, verifies exact per-chunk and aggregate byte counts, and requires `file_complete` before exposing the file. JSON `file_chunk` messages are retained only for negotiated Base64 fallback.

Senders respect `bufferedAmount` backpressure and fail on channel stalls, close, cancellation, malformed frames, or timeout. Browser receivers use the File System Access API when available to stream directly to a user-selected destination; otherwise chunks are retained only as bounded binary parts until the user saves the completed file. Zero-byte files use zero chunks and still require completion.

The browser defaults are a 2 GiB file limit, 16,384 chunks, 256 KiB binary chunks, 4 MiB buffered-channel high water mark, 30 second stall timeout, and a 32 MiB threshold before offering direct-to-disk saving. These are configuration limits, not unlimited-capacity claims. Android remains capped at its advertised 25 MiB Base64 compatibility limit until its native receiver is migrated to the binary frame helper.

## Capabilities

```json
{"type":"capabilities","screen":true,"dataChannels":true,"clipboard":true,"fileTransfer":true,"chat":true,"nativeInput":false}
```

Unsupported features must be reported as unsupported rather than simulated.

## Input

Pointer coordinates are normalized to 0..1. Keyboard events carry key, code, action and modifiers. Every input event has a recent timestamp.

The browser milestone validates and transports these events but does not inject them into the operating system. A native host agent is required for OS-level mouse and keyboard control.
