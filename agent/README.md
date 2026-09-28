# Native host agent

The browser client can transport validated input intents, but OS-level input requires a local native process.

This repository includes a lightweight Node/PowerShell bridge for PC hosts:

```bash
node agent/host-agent.mjs
```

The bridge listens only on 127.0.0.1:17878. Before using a deployed Pages origin, set the exact allowed origin:

```text
P2P_DESK_AGENT_ORIGINS=https://YOUR-OWNER.github.io
```

Windows uses a persistent PowerShell helper with Win32 SendInput/SetCursorPos. Linux can use xdotool when installed. macOS currently reports nativeInput=false because its Accessibility automation adapter is not included.

The agent never receives SDP, screen media, session codes, passwords, or files. It receives only validated input messages after the browser has granted control.

For a production product, replace the bridge with signed per-platform installers, stronger pairing/authentication, visible session indicators, an emergency stop, and platform-specific permission handling.
