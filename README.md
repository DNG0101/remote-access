# P2P Desk

P2P Desk is a GitHub Pages-ready browser client for a consent-first remote support product. The public Pages build uses PeerJS Cloud for browser-to-browser signaling and WebRTC for the actual peer connection, while browser screen capture and control permissions remain explicit.

## What is included

- Static deployment: `index.html`, `styles.css`, `app.js`, `webrtc.js`, `config.js`
- Cross-device P2P sessions on the public GitHub Pages URL using PeerJS Cloud for signaling and WebRTC for media/data
- Same-device testing still works in multiple tabs/windows
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
2. The built-in PeerJS Cloud broker for browser session discovery/signaling, or an optional self-hosted PeerServer when you need your own signaling boundary.
3. A TURN service with short-lived credentials for restrictive networks.
4. A visible, user-installed native host agent for Windows first. The agent must implement capture, OS input, permissions, clipboard, files, monitor metadata, and an emergency stop.

## Run locally

Because screen capture and WebRTC require a secure context, use `localhost` or HTTPS:

```bash
python3 -m http.server 8080
```

Open the site in a browser, create a Host session, and use **Copy invite link**. Open that invite link on the second device/browser. The six-digit code is a human-readable session reference; the invite link also carries the broker peer ID required to locate the host through PeerJS Cloud.

The host and controller establish a view-only WebRTC connection automatically. Screen sharing is a separate host action. Control requests happen only after the peer connection is established.

PeerJS Cloud handles signaling/brokering; the media and data paths are WebRTC peer connections. PeerJS documents that the signaling server is used to broker the connection and that direct peer data does not pass through the signaling server (TURN can be used when NAT traversal requires it).

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

PeerJS Cloud is suitable for the prototype broker path; a production self-hosted broker still needs authentication, authorization, session expiration, rate limits, peer limits, message validation, and should never proxy screen or input traffic. See `docs/architecture.md`, `docs/protocol.md`, and `docs/security.md`.

## Project status

| Area | Status |
|---|---|
| Static web client | Included |
| Two-tab WebRTC milestone | Included |
| Browser screen capture | Included |
| Consent and view-only default | Included |
| Diagnostics | Included |
| Public signaling/brokering | PeerJS Cloud enabled; optional self-hosted PeerServer/custom signaling supported |
| TURN fallback | Configuration hook included; credentials/service required |
| Windows OS control | Not included; requires native agent |
| macOS/Linux agents | Not included |
| Android native client/host | Not included |
| Browser E2E suite | Playwright coverage added for browser connection/media/control lifecycle |

## Safety

The UI makes no claim that a browser has unrestricted operating-system access. Never use this package to bypass OS permission dialogs, install a hidden host, or access another person's screen without clear consent.