# P2P Desk

P2P Desk is a GitHub Pages-ready browser client for a consent-first remote support product. This package implements the first safe milestone: a responsive session workspace, same-origin two-tab WebRTC connectivity, browser screen capture, explicit view/control consent, separate data channels, telemetry, and honest capability reporting.

## What is included

- Static deployment: `index.html`, `styles.css`, `app.js`, `webrtc.js`, `config.js`
- Same-origin two-tab P2P demo using `BroadcastChannel` only for signaling and `RTCPeerConnection` for the session
- Browser screen sharing via `getDisplayMedia()`
- Separate `control`, `input`, `clipboard`, `file-transfer`, `telemetry`, and `chat` channels
- View-only by default, visible control approval, and host session termination
- Diagnostics page with browser-observed connection state, ICE state, signaling state, channel state, and WebRTC stats
- Architecture and security handoff notes in `docs/`
- GitHub Pages workflow in `.github/workflows/pages.yml`

## Important boundary

This is not yet a production remote desktop product. A browser cannot move the OS cursor, type into arbitrary Windows applications, enumerate native file paths, or silently access the clipboard. The app does **not** pretend otherwise.

For real cross-device sessions, deploy:

1. This static client on GitHub Pages.
2. A TLS WebSocket signaling service that exchanges only SDP, ICE candidates, and session metadata.
3. A TURN service with short-lived credentials for restrictive networks.
4. A visible, user-installed native host agent for Windows first. The agent must implement capture, OS input, permissions, clipboard, files, monitor metadata, and an emergency stop.

## Run locally

Because screen capture and WebRTC require a secure context, use a local HTTPS server or `localhost`:

```bash
python3 -m http.server 8080
```

Open `http://localhost:8080` in two tabs. Create a Host session in one tab, copy the six-digit code, choose Controller in the other, and join. The local demo uses a same-origin `BroadcastChannel` to exchange the WebRTC offer/answer/candidates; desktop screen media travels through the peer connection.

For the cleanest test, start screen sharing on the host before accepting a viewer. If you start it after the peer is connected, the browser client attempts a renegotiation, but native-agent integration is still required for true OS control.

## Deploy to GitHub Pages

1. Create a GitHub repository and upload the contents of this ZIP at the repository root.
2. In **Settings → Pages**, choose **GitHub Actions** as the source.
3. The included workflow publishes the repository root.
4. Visit the generated `https://<owner>.github.io/<repository>/` URL.

No build step is required. `config.js` contains only public configuration. Do not commit TURN passwords, API keys, access tokens, or private credentials.

## Configure signaling

Edit `config.js`:

```js
window.P2P_DESK_CONFIG = {
  signalingUrl: "wss://signal.example.com",
  iceServers: [
    { urls: ["stun:stun.example.com:3478"] }
    // TURN credentials must come from a short-lived credential endpoint.
  ]
};
```

The included client sends a small JSON message shape:

```json
{ "type": "join", "code": "123456", "role": "controller" }
{ "type": "offer", "description": { "type": "offer", "sdp": "..." } }
{ "type": "answer", "description": { "type": "answer", "sdp": "..." } }
{ "type": "candidate", "candidate": { "...": "..." } }
```

The signaling service must authenticate and authorize sessions, expire codes, rate-limit joins, limit peers, validate message size and shape, and never proxy screen or input traffic. See `docs/architecture.md`, `docs/protocol.md`, and `docs/security.md`.

## Project status

| Area | Status |
|---|---|
| Static web client | Included |
| Two-tab WebRTC milestone | Included |
| Browser screen capture | Included |
| Consent and view-only default | Included |
| Diagnostics | Included |
| Production signaling | Interface/config included; service not included |
| TURN fallback | Configuration hook included; credentials/service required |
| Windows OS control | Not included; requires native agent |
| macOS/Linux agents | Not included |
| Android native client/host | Not included |
| 100+ production E2E suite | Checklist and strategy included; not claimed as passed |

## Safety

The UI makes no claim that a browser has unrestricted operating-system access. Never use this package to bypass OS permission dialogs, install a hidden host, or access another person's screen without clear consent.