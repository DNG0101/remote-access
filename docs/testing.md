# Testing plan

This package includes a runnable browser milestone, not a claim that the full 168-flow product test plan has passed.

## Manual smoke test

1. Serve the root over `localhost` or HTTPS.
2. Open two same-origin tabs.
3. Create a Host session and copy the code.
4. Join as Controller from the second tab.
5. Approve the viewer on the host.
6. Confirm `connected`, ICE, signaling, and data-channel status in Diagnostics.
7. Start browser screen sharing and confirm the remote video track arrives.
8. Request control; approve and confirm the UI changes to full control.
9. End the session from either side.
10. Confirm the session closes and no screen remains visible.

## Before production

Add automated unit, integration, browser E2E, security, performance, mobile, and native-agent suites. Cover expiration, invalid sessions, replay, malformed messages, consent revocation, TURN relay, ICE restart, network changes, capture stop, permission denial, file restrictions, clipboard denial, mixed-DPI monitors, and host emergency stop.