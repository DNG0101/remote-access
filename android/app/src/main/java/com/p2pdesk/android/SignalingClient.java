package com.p2pdesk.android;

import android.os.Handler;
import android.os.Looper;

import org.java_websocket.client.WebSocketClient;
import org.java_websocket.handshake.ServerHandshake;
import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URI;
import java.util.UUID;

public final class SignalingClient {
    public interface Listener {
        void onConnected();
        void onPeerJoined(String peerId);
        void onSignal(JSONObject message);
        void onError(String message);
        void onClosed();
    }

    private final Handler main =
        new Handler(Looper.getMainLooper());
    private final Listener listener;
    private final String url;
    private final String roomId;
    private final String peerId;

    private WebSocketClient socket;

    public SignalingClient(
        String url,
        String roomId,
        Listener listener
    ) {
        this.url = url;
        this.roomId = roomId;
        this.listener = listener;
        this.peerId = UUID.randomUUID().toString();
    }

    public String getPeerId() {
        return peerId;
    }

    public void connect() throws Exception {
        URI uri = URI.create(url);
        String scheme = uri.getScheme();

        if (!"ws".equalsIgnoreCase(scheme) &&
            !"wss".equalsIgnoreCase(scheme)) {
            throw new IllegalArgumentException(
                "Signaling URL must use ws:// or wss://."
            );
        }

        socket = new WebSocketClient(uri) {
            @Override
            public void onOpen(ServerHandshake handshake) {
                try {
                    JSONObject announce = new JSONObject()
                        .put("announce", true)
                        .put("role", "host");

                    send(envelope(announce));
                    main.post(listener::onConnected);
                } catch (Exception error) {
                    main.post(() ->
                        listener.onError(error.getMessage())
                    );
                }
            }

            @Override
            public void onMessage(String message) {
                try {
                    JSONObject packet =
                        new JSONObject(message);

                    if (packet.optBoolean("server") &&
                        "error".equals(
                            packet.optString("kind")
                        )) {
                        main.post(() ->
                            listener.onError(
                                packet.optString(
                                    "message",
                                    "Signaling server rejected the session."
                                )
                            )
                        );
                        return;
                    }

                    if ("roster".equals(
                        packet.optString("sys")
                    )) {
                        JSONArray roster =
                            packet.optJSONArray("roster");

                        if (roster != null) {
                            for (int i = 0;
                                 i < roster.length();
                                 i++) {
                                String candidate =
                                    roster.optString(i, "");

                                if (!peerId.equals(candidate) &&
                                    !candidate.isEmpty()) {
                                    main.post(() ->
                                        listener.onPeerJoined(
                                            candidate
                                        )
                                    );
                                    return;
                                }
                            }
                        }
                        return;
                    }

                    if (!roomId.equals(
                        packet.optString("roomId")
                    )) {
                        return;
                    }

                    if (peerId.equals(
                        packet.optString("from")
                    )) {
                        return;
                    }

                    if (packet.has("to") &&
                        !packet.isNull("to") &&
                        !peerId.equals(
                            packet.optString("to")
                        )) {
                        return;
                    }

                    if (packet.optBoolean("announce") &&
                        "controller".equals(
                            packet.optString("role")
                        )) {
                        String controllerId =
                            packet.optString("from", "");

                        if (!controllerId.isEmpty()) {
                            main.post(() ->
                                listener.onPeerJoined(
                                    controllerId
                                )
                            );
                        }
                        return;
                    }

                    main.post(() ->
                        listener.onSignal(packet)
                    );
                } catch (Exception error) {
                    main.post(() ->
                        listener.onError(
                            "Invalid signaling message: " +
                            error.getMessage()
                        )
                    );
                }
            }

            @Override
            public void onClose(
                int code,
                String reason,
                boolean remote
            ) {
                main.post(listener::onClosed);
            }

            @Override
            public void onError(Exception error) {
                main.post(() ->
                    listener.onError(
                        error == null
                            ? "Signaling socket error."
                            : String.valueOf(error.getMessage())
                    )
                );
            }
        };

        socket.connect();
    }

    private JSONObject envelope(JSONObject payload)
        throws Exception {
        JSONObject message =
            new JSONObject(payload.toString());

        message.put("roomId", roomId);
        message.put("from", peerId);
        message.put("to", JSONObject.NULL);
        message.put("sentAt", System.currentTimeMillis());

        return message;
    }

    public void sendSignal(
        JSONObject payload,
        String to
    ) {
        if (socket == null || !socket.isOpen()) return;

        try {
            JSONObject message = envelope(payload);
            message.put(
                "to",
                to == null ? JSONObject.NULL : to
            );
            socket.send(message.toString());
        } catch (Exception error) {
            main.post(() ->
                listener.onError(error.getMessage())
            );
        }
    }

    public void close() {
        try {
            if (socket != null) socket.close();
        } catch (Exception ignored) {
        }
    }
}
