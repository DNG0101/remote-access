# Protocol notes

Protocol version: `1.0.0`

## WebRTC logical channels

| Channel | Ordering | Purpose |
|---|---|---|
| `control` | ordered | consent, session lifecycle, capability messages |
| `input` | unordered/low-latency intent | normalized pointer and keyboard events |
| `clipboard` | ordered | user-approved text clipboard messages |
| `file-transfer` | ordered | chunk metadata and explicitly approved file bytes |
| `telemetry` | ordered | connection measurements and capability status |
| `chat` | ordered | session messages |

## Input examples

```json
{
  "type": "mouse_move",
  "timestamp": 1730000000000,
  "x": 0.45,
  "y": 0.72,
  "monitorId": "monitor-1"
}
```

```json
{
  "type": "keyboard",
  "key": "Enter",
  "action": "down",
  "modifiers": ["CTRL"]
}
```

Every native agent must validate message type, size, timestamp freshness, permission state, rate, coordinate range, monitor identity, and control grant before acting.

## Capability negotiation

Each peer should announce protocol version, client version, host-agent version, and capabilities. Unsupported features must be disabled rather than simulated.

## State model

The product state model is:

`IDLE → CREATING → WAITING → JOINING → SIGNALING → CONNECTING → AUTHENTICATING → WAITING_FOR_CONSENT → VIEW_ONLY → FULL_CONTROL → CLOSED`

Recoverable transport states include `RECONNECTING`; terminal states include `DISCONNECTED`, `EXPIRED`, `FAILED`, and `CLOSED`.