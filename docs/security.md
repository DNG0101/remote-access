# Security model

## Defaults

- No account is required for the local demo, but production signaling must authenticate sessions.
- View-only is the default.
- Full control requires a host action.
- The host can terminate the session immediately.
- The browser uses WebRTC's encrypted transport.
- No secrets are stored in the static bundle.
- Clipboard and files are explicit user actions, not background synchronization.

## Production requirements before launch

1. Use HTTPS/WSS only.
2. Generate session IDs with a cryptographically secure random source.
3. Give session credentials a short lifetime and bind them to the session.
4. Rate-limit session creation, joins, renegotiation, input, and file chunks.
5. Validate every signaling and data-channel message against a schema.
6. Enforce maximum message, file, and session sizes.
7. Reject stale/replayed control messages.
8. Avoid logging credentials, clipboard contents, file contents, and raw input payloads.
9. Use a visible native host permission indicator and emergency stop.
10. Never auto-execute received files or allow arbitrary native filesystem paths.

## Threats

- Session code guessing: use high-entropy codes/tokens, expiration, and rate limits.
- Malicious controller: host consent, capability scopes, input validation, and immediate stop.
- Malicious host: controller should show identity/session metadata and allow immediate disconnect.
- TURN exposure: use short-lived credentials and treat relay routing honestly.
- Browser permission abuse: rely on platform prompts; do not bypass them.