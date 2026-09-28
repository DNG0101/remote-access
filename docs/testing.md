# Testing plan

The current browser milestone has automated unit, integration, static, and Playwright E2E coverage.

## Automated browser flow

The Playwright flow verifies:

1. Host session creation.
2. Controller join by six-digit code.
3. WSS signaling.
4. WebRTC peer connection.
5. Screen capture before peer join.
6. Remote video track delivery.
7. Bidirectional chat.
8. Controller clipboard transfer to the host browser.
9. Host-to-controller file transfer with download verification.
10. Controller-to-host file transfer with download verification.
11. Control request and host approval.
12. Host control revocation.
13. Explicit session disconnect and peer-side state update.
14. No uncaught browser page errors.

## Protocol coverage

Node tests cover session-code generation, signaling envelopes, input freshness and bounds, control freshness, chat schema, file size/chunk constraints, telemetry/capability schemas, channel validation, signaling room membership, role conflicts, explicit leave propagation, queued data-channel messages, and roster discovery.

## Production/native test expansion

A complete native remote-desktop product still needs platform suites for TURN-only paths, ICE restart, network changes, sleep/wake, multiple monitors, mixed-DPI scaling, capture permission revocation, OS input permission denial, clipboard denial, interrupted/resumable file transfer, native-agent authentication, emergency stop, Windows, macOS, Linux, and Android host implementations.
