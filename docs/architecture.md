# Architecture

```text
                  GitHub Pages
                 static web client
                       |
              WSS signaling service
              SDP / ICE / session metadata
                       |
          +------------+-------------+
          |                          |
       CONTROLLER                  HOST
       web browser          browser / native agent
          |                          |
          +------ WebRTC P2P --------+
          screen media + data channels
```

The signaling layer introduces peers; it is not a remote desktop proxy. Prefer a direct ICE candidate pair. If a TURN candidate pair is selected, the UI must label the route as relay. The client only reports `RTCPeerConnection` state and stats that the browser exposes.

## Deployment boundaries

- GitHub Pages: static files only.
- Signaling: separate TLS WebSocket service, short-lived sessions, authentication, rate limits, expiration.
- TURN: separate service; credentials should be minted shortly before use.
- Host agent: visible native process, explicit permissions, session indicator, emergency stop.

The browser implementation in this ZIP is intentionally limited to screen capture selected through the browser permission prompt. `getDisplayMedia()` does not provide arbitrary desktop automation.