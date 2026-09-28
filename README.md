# P2P Desk

P2P Desk is a GitHub Pages-ready browser remote-support client built around a direct WebRTC peer connection. The signaling service only introduces peers and relays SDP/ICE; screen media and data channels use the peer connection.

## Current browser modules

The browser milestone implements these end-to-end modules:

- Six-digit session creation and joining.
- Native WebSocket signaling with direct peer targeting.
- WebRTC SDP/ICE negotiation with candidate buffering and renegotiation.
- Browser screen sharing through getDisplayMedia().
- View-only sessions by default.
- Explicit control request/approval/revocation messages.
- Normalized mouse/keyboard input messages over the input channel.
- User-initiated text clipboard transfer from controller to host browser.
- Bidirectional chat over the chat data channel.
- Bidirectional file transfer up to 25 MB using chunked, ordered WebRTC data-channel messages.
- Capability discovery and lightweight telemetry.
- Android-friendly touch control with an on-screen mobile keyboard routed through the native PC agent.
- Connection/ICE/data-channel diagnostics.
- Explicit peer-leave propagation and teardown.
- Browser E2E coverage for connection, screen delivery, control, clipboard, chat, bidirectional file transfer, and disconnect.

## What the browser cannot do

A normal browser page cannot move the Windows/macOS/Linux system cursor, type into arbitrary native applications, read arbitrary native filesystem paths, run native processes, bypass permission prompts, or provide a true Android system-level host without a native Android application.

The browser therefore sends validated input intents, but the host page does not pretend those intents are OS actions. OS control requires the separately installed native host agent. The host can enable it with the agent query parameter, for example `?agent=ws%3A%2F%2F127.0.0.1%3A17878`; current Chrome supports loopback WebSocket targeting with a local-network permission prompt.
## Architecture

GitHub Pages -> WSS signaling -> Host browser <-> Controller browser over WebRTC.

The signaling layer never proxies the screen stream or data-channel payloads.

## Configuration

Edit config.js:

```js
window.P2P_DESK_CONFIG = {
  signalingUrl: "wss://signal.example.com",
  iceServers: [
    { urls: ["stun:stun.example.com:3478"] }
  ],
  sessionTtlMinutes: 30,
  maxFileBytes: 25 * 1024 * 1024
};
```

For restrictive networks, configure a TURN service with short-lived credentials. Do not commit TURN passwords or private API credentials.

## Local development

Serve the repository from localhost or HTTPS so browser media and WebRTC APIs are available:

```bash
python3 -m http.server 8080
```

The automated E2E suite starts an isolated HTTP server plus a local WSS signaling server on ports 4173/4174.

## GitHub Pages

1. Enable GitHub Pages for the repository.
2. Publish the repository root.
3. Open the generated HTTPS site.
4. The client uses the configured WSS signaling endpoint.

Invite links contain the six-digit room code and the configured signaling endpoint.

## Native-agent boundary

To turn this browser milestone into a full OS remote-desktop product, add signed native host components per platform:

- Windows: capture, monitors, OS input, clipboard, filesystem operations, emergency stop.
- macOS: Screen Recording and Accessibility permissions with equivalent controls.
- Linux: desktop-environment-specific capture/input integration with explicit permissions.
- Android: MediaProjection for screen capture and an AccessibilityService for user-approved input automation.

Native components must authenticate to the session, enforce the same protocol validators, show a visible session indicator, and never execute arbitrary received files.

## Security baseline

View-only is the default. Control requires an explicit host decision. File offers require recipient approval. Clipboard transfer is user initiated. Session identifiers expire, signaling input is validated, data messages have size/freshness limits, and the signaling service is not used as a screen/data proxy.


## PC → Android

The repository includes a native Android host under android/. A PC browser can connect to the phone using the same six-digit room flow. The phone owner must approve Android screen capture and enable the P2P Desk AccessibilityService before remote control can operate.