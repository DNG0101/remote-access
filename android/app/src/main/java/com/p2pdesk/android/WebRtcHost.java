package com.p2pdesk.android;

import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Point;
import android.view.Display;
import android.view.WindowManager;

import org.json.JSONObject;
import org.webrtc.DataChannel;
import org.webrtc.DefaultVideoDecoderFactory;
import org.webrtc.DefaultVideoEncoderFactory;
import org.webrtc.EglBase;
import org.webrtc.IceCandidate;
import org.webrtc.MediaConstraints;
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.ScreenCapturerAndroid;
import org.webrtc.SdpObserver;
import org.webrtc.SessionDescription;
import org.webrtc.SurfaceTextureHelper;
import org.webrtc.VideoSource;
import org.webrtc.VideoTrack;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public final class WebRtcHost {
    public interface Listener {
        void onState(String state);
        void onMessage(String channel, JSONObject message);
        void onError(String message);
    }

    private static final List<String> CHANNELS =
        Arrays.asList(
            "control",
            "input",
            "clipboard",
            "file-transfer",
            "telemetry",
            "chat"
        );

    private final Context context;
    private final SignalingClient signaling;
    private final Listener listener;
    private final boolean shareMicrophone;

    private PeerConnectionFactory factory;
    private EglBase eglBase;
    private SurfaceTextureHelper textureHelper;
    private VideoSource videoSource;
    private VideoTrack videoTrack;
    private org.webrtc.AudioSource audioSource;
    private org.webrtc.AudioTrack audioTrack;
    private ScreenCapturerAndroid screenCapturer;
    private PeerConnection peerConnection;
    private String remotePeerId;
    private boolean remoteDescriptionSet;
    private final List<IceCandidate> pendingRemoteCandidates =
        new ArrayList<>();
    private final Map<String, DataChannel> channels =
        new HashMap<>();
    private boolean started;
    private boolean capabilitiesSent;

    public WebRtcHost(
        Context context,
        SignalingClient signaling,
        Listener listener,
        boolean shareMicrophone
    ) {
        this.context = context.getApplicationContext();
        this.signaling = signaling;
        this.listener = listener;
        this.shareMicrophone = shareMicrophone;
    }

    public void start(Intent projectionData) {
        if (started) return;
        started = true;

        try {
            PeerConnectionFactory.initialize(
                PeerConnectionFactory
                    .InitializationOptions
                    .builder(context)
                    .createInitializationOptions()
            );

            eglBase = EglBase.create();

            PeerConnectionFactory.Builder builder =
                PeerConnectionFactory
                    .builder()
                    .setVideoEncoderFactory(
                        new DefaultVideoEncoderFactory(
                            eglBase.getEglBaseContext(),
                            true,
                            true
                        )
                    )
                    .setVideoDecoderFactory(
                        new DefaultVideoDecoderFactory(
                            eglBase.getEglBaseContext()
                        )
                    );

            factory = builder.createPeerConnectionFactory();

            if (shareMicrophone) {
                audioSource =
                    factory.createAudioSource(
                        new MediaConstraints()
                    );

                audioTrack =
                    factory.createAudioTrack(
                        "p2p-desk-microphone",
                        audioSource
                    );

                audioTrack.setEnabled(true);
            }

            startScreenCapture(projectionData);
            signaling.connect();
            listener.onState("SIGNALING_CONNECTING");
        } catch (Exception error) {
            listener.onError(
                "Android host startup failed: " +
                error.getMessage()
            );
            stop();
        }
    }

    private void startScreenCapture(
        Intent permissionData
    ) throws Exception {
        WindowManager manager =
            (WindowManager)
                context.getSystemService(
                    Context.WINDOW_SERVICE
                );
        Display display = manager.getDefaultDisplay();

        Point size = new Point();
        display.getRealSize(size);

        double scale =
            Math.min(
                1.0,
                1920.0 /
                    Math.max(1, Math.max(size.x, size.y))
            );

        int width =
            Math.max(
                2,
                ((int) Math.round(size.x * scale)) & ~1
            );
        int height =
            Math.max(
                2,
                ((int) Math.round(size.y * scale)) & ~1
            );

        videoSource =
            factory.createVideoSource(false);

        textureHelper =
            SurfaceTextureHelper.create(
                "P2PDeskScreenCapture",
                eglBase.getEglBaseContext()
            );

        screenCapturer =
            new ScreenCapturerAndroid(
                permissionData,
                new android.media.projection.MediaProjection.Callback() {
                    @Override
                    public void onStop() {
                        try {
                            listener.onMessage(
                                "control",
                                new JSONObject().put(
                                    "type",
                                    "screen_stopped"
                                )
                            );
                        } catch (Exception error) {
                            listener.onError(error.getMessage());
                        }
                    }
                }
            );

        screenCapturer.initialize(
            textureHelper,
            context,
            videoSource.getCapturerObserver()
        );

        screenCapturer.startCapture(
            width,
            height,
            30
        );

        videoTrack =
            factory.createVideoTrack(
                "p2p-desk-screen",
                videoSource
            );
    }

    public synchronized void onPeerJoined(
        String peerId
    ) {
        if (peerId == null || peerId.isEmpty()) return;
        remotePeerId = peerId;

        if (peerConnection != null) return;

        PeerConnection.RTCConfiguration configuration =
            new PeerConnection.RTCConfiguration(
                Arrays.asList(
                    PeerConnection.IceServer
                        .builder(
                            "stun:stun.l.google.com:19302"
                        )
                        .createIceServer()
                )
            );

        configuration.sdpSemantics =
            PeerConnection.SdpSemantics.UNIFIED_PLAN;

        peerConnection =
            factory.createPeerConnection(
                configuration,
                new PeerConnection.Observer() {
                    @Override
                    public void onSignalingChange(
                        PeerConnection.SignalingState state
                    ) {
                    }

                    @Override
                    public void onIceConnectionChange(
                        PeerConnection.IceConnectionState state
                    ) {
                        listener.onState(
                            "ICE_" + state.name()
                        );
                    }

                    @Override
                    public void onIceConnectionReceivingChange(
                        boolean receiving
                    ) {
                    }

                    @Override
                    public void onIceGatheringChange(
                        PeerConnection.IceGatheringState state
                    ) {
                    }

                    @Override
                    public void onIceCandidate(
                        IceCandidate candidate
                    ) {
                        try {
                            JSONObject json =
                                new JSONObject()
                                    .put(
                                        "sdpMid",
                                        candidate.sdpMid
                                    )
                                    .put(
                                        "sdpMLineIndex",
                                        candidate.sdpMLineIndex
                                    )
                                    .put(
                                        "candidate",
                                        candidate.sdp
                                    );

                            signaling.sendSignal(
                                new JSONObject()
                                    .put(
                                        "kind",
                                        "candidate"
                                    )
                                    .put(
                                        "candidate",
                                        json
                                    ),
                                remotePeerId
                            );
                        } catch (Exception error) {
                            listener.onError(
                                error.getMessage()
                            );
                        }
                    }

                    @Override
                    public void onIceCandidatesRemoved(
                        IceCandidate[] candidates
                    ) {
                    }

                    @Override
                    public void onAddStream(
                        org.webrtc.MediaStream stream
                    ) {
                    }

                    @Override
                    public void onRemoveStream(
                        org.webrtc.MediaStream stream
                    ) {
                    }

                    @Override
                    public void onDataChannel(
                        DataChannel channel
                    ) {
                        attachChannel(channel);
                    }

                    @Override
                    public void onRenegotiationNeeded() {
                    }

                    @Override
                    public void onAddTrack(
                        org.webrtc.RtpReceiver receiver,
                        org.webrtc.MediaStream[] streams
                    ) {
                    }

                    @Override
                    public void onConnectionChange(
                        PeerConnection.PeerConnectionState state
                    ) {
                        listener.onState(
                            "PEER_" + state.name()
                        );
                    }
                }
            );

        if (peerConnection == null) {
            listener.onError(
                "Could not create Android WebRTC peer connection."
            );
            return;
        }

        if (videoTrack != null) {
            peerConnection.addTrack(
                videoTrack,
                Arrays.asList("screen")
            );
        }

        if (audioTrack != null) {
            peerConnection.addTrack(
                audioTrack,
                Arrays.asList("audio")
            );
        }

        for (String channelName : CHANNELS) {
            DataChannel.Init init =
                new DataChannel.Init();
            init.ordered = true;

            attachChannel(
                peerConnection.createDataChannel(
                    channelName,
                    init
                )
            );
        }

        listener.onState("OFFERING");
        createOffer();
    }

    private void attachChannel(
        DataChannel channel
    ) {
        if (channel == null ||
            !CHANNELS.contains(channel.label())) {
            if (channel != null) channel.close();
            return;
        }

        DataChannel old =
            channels.put(channel.label(), channel);

        if (old != null) old.close();

        channel.registerObserver(
            new DataChannel.Observer() {
                @Override
                public void onBufferedAmountChange(
                    long previousAmount
                ) {
                }

                @Override
                public void onStateChange() {
                    listener.onState(
                        "CHANNEL_" +
                        channel.label() +
                        "_" +
                        channel.state().name()
                    );

                    if (
                        "telemetry".equals(channel.label()) &&
                        channel.state() ==
                            DataChannel.State.OPEN
                    ) {
                        sendCapabilities();
                    }
                }

                @Override
                public void onMessage(
                    DataChannel.Buffer buffer
                ) {
                    try {
                        ByteBuffer data =
                            buffer.data.slice();

                        byte[] bytes =
                            new byte[data.remaining()];
                        data.get(bytes);

                        JSONObject message =
                            new JSONObject(
                                new String(
                                    bytes,
                                    StandardCharsets.UTF_8
                                )
                            );

                        listener.onMessage(
                            channel.label(),
                            message
                        );
                    } catch (Exception error) {
                        listener.onError(
                            "Invalid " +
                            channel.label() +
                            " message."
                        );
                    }
                }
            }
        );
    }

    private void sendCapabilities() {
        if (capabilitiesSent) return;

        try {
            JSONObject message = new JSONObject()
                .put("type", "capabilities")
                .put("screen", true)
                .put("dataChannels", true)
                .put("clipboard", true)
                .put("fileTransfer", true)
                .put("chat", true)
                .put("nativeInput", true)
                .put("androidHost", true)
                .put("touchGestures", true)
                .put("deviceActions", true)
                .put("microphone", shareMicrophone);

            if (!send("telemetry", message)) return;

            capabilitiesSent = true;
            sendDeviceInfo();
        } catch (Exception error) {
            listener.onError(
                "Android capability negotiation failed: " +
                error.getMessage()
            );
        }
    }

    private void sendDeviceInfo() {
        try {
            WindowManager manager =
                (WindowManager)
                    context.getSystemService(
                        Context.WINDOW_SERVICE
                    );

            Display display =
                manager.getDefaultDisplay();

            Point size = new Point();
            display.getRealSize(size);

            float density =
                context.getResources()
                    .getDisplayMetrics()
                    .density;

            float battery = -1f;

            try {
                Intent batteryIntent =
                    context.registerReceiver(
                        null,
                        new IntentFilter(
                            Intent.ACTION_BATTERY_CHANGED
                        )
                    );

                if (batteryIntent != null) {
                    int level =
                        batteryIntent.getIntExtra(
                            android.os.BatteryManager.EXTRA_LEVEL,
                            -1
                        );

                    int scale =
                        batteryIntent.getIntExtra(
                            android.os.BatteryManager.EXTRA_SCALE,
                            -1
                        );

                    if (level >= 0 && scale > 0) {
                        battery =
                            100f *
                            ((float) level / (float) scale);
                    }
                }
            } catch (Exception ignored) {
            }

            JSONObject message =
                new JSONObject()
                    .put("type", "device_info")
                    .put("at", System.currentTimeMillis())
                    .put(
                        "manufacturer",
                        android.os.Build.MANUFACTURER
                    )
                    .put(
                        "model",
                        android.os.Build.MODEL
                    )
                    .put(
                        "sdk",
                        android.os.Build.VERSION.SDK_INT
                    )
                    .put("width", size.x)
                    .put("height", size.y)
                    .put("density", density)
                    .put(
                        "rotation",
                        display.getRotation() / 90
                    );

            if (battery >= 0f) {
                message.put("battery", battery);
            }

            send("telemetry", message);
        } catch (Exception error) {
            listener.onError(
                "Android device telemetry failed: " +
                error.getMessage()
            );
        }
    }

    private void createOffer() {
        if (peerConnection == null) return;

        peerConnection.createOffer(
            new SdpObserver() {
                @Override
                public void onCreateSuccess(
                    SessionDescription description
                ) {
                    peerConnection.setLocalDescription(
                        new SimpleSdpObserver() {
                            @Override
                            public void onSetSuccess() {
                                try {
                                    JSONObject value =
                                        new JSONObject()
                                            .put(
                                                "type",
                                                description.type
                                                    .canonicalForm()
                                            )
                                            .put(
                                                "sdp",
                                                description.description
                                            );

                                    signaling.sendSignal(
                                        new JSONObject()
                                            .put(
                                                "kind",
                                                "offer"
                                            )
                                            .put(
                                                "description",
                                                value
                                            ),
                                        remotePeerId
                                    );
                                } catch (Exception error) {
                                    listener.onError(
                                        error.getMessage()
                                    );
                                }
                            }

                            @Override
                            public void onSetFailure(
                                String error
                            ) {
                                listener.onError(
                                    "Local description failed: " +
                                    error
                                );
                            }
                        },
                        description
                    );
                }

                @Override
                public void onSetSuccess() {
                }

                @Override
                public void onCreateFailure(
                    String error
                ) {
                    listener.onError(
                        "Offer creation failed: " +
                        error
                    );
                }

                @Override
                public void onSetFailure(
                    String error
                ) {
                    listener.onError(
                        "Local offer failed: " +
                        error
                    );
                }
            },
            new MediaConstraints()
        );
    }

    public void onSignal(JSONObject message) {
        try {
            String kind =
                message.optString("kind");

            if ("answer".equals(kind)) {
                JSONObject description =
                    message.getJSONObject("description");

                SessionDescription answer =
                    new SessionDescription(
                        SessionDescription.Type
                            .fromCanonicalForm(
                                description.getString("type")
                            ),
                        description.getString("sdp")
                    );

                peerConnection.setRemoteDescription(
                    new SimpleSdpObserver() {
                        @Override
                        public void onSetSuccess() {
                            listener.onState(
                                "ANSWER_APPLIED"
                            );
                        }

                        @Override
                        public void onSetFailure(
                            String error
                        ) {
                            listener.onError(
                                "Remote answer rejected: " +
                                error
                            );
                        }
                    },
                    answer
                );

                return;
            }

            if ("candidate".equals(kind)) {
                if (peerConnection == null) return;

                JSONObject candidate =
                    message.getJSONObject("candidate");

                IceCandidate iceCandidate =
                    new IceCandidate(
                        candidate.optString(
                            "sdpMid",
                            null
                        ),
                        candidate.optInt(
                            "sdpMLineIndex",
                            0
                        ),
                        candidate.getString("candidate")
                    );

                if (!remoteDescriptionSet) {
                    pendingRemoteCandidates.add(iceCandidate);
                } else {
                    peerConnection.addIceCandidate(iceCandidate);
                }

                return;
            }

            if ("leave".equals(kind)) {
                remotePeerId = null;
                closePeerConnection();
                listener.onState("PEER_LEFT");
            }
        } catch (Exception error) {
            listener.onError(
                "WebRTC signaling error: " +
                error.getMessage()
            );
        }
    }

    public boolean send(
        String channel,
        JSONObject message
    ) {
        DataChannel dataChannel =
            channels.get(channel);

        if (dataChannel == null ||
            dataChannel.state() !=
                DataChannel.State.OPEN) {
            return false;
        }

        byte[] bytes =
            message.toString()
                .getBytes(StandardCharsets.UTF_8);

        return dataChannel.send(
            new DataChannel.Buffer(
                ByteBuffer.wrap(bytes),
                false
            )
        );
    }

    private void closePeerConnection() {
        for (DataChannel channel : channels.values()) {
            try { channel.close(); } catch (Exception ignored) {}
        }

        channels.clear();
        pendingRemoteCandidates.clear();
        remoteDescriptionSet = false;
        capabilitiesSent = false;

        if (peerConnection != null) {
            peerConnection.close();
            peerConnection.dispose();
            peerConnection = null;
        }
    }

    public void stop() {
        if (!started) return;
        started = false;

        closePeerConnection();

        if (screenCapturer != null) {
            try {
                screenCapturer.stopCapture();
            } catch (Exception ignored) {
            }
            screenCapturer.dispose();
        }

        if (textureHelper != null) {
            textureHelper.dispose();
        }
        if (videoSource != null) {
            videoSource.dispose();
        }
        if (videoTrack != null) {
            videoTrack.dispose();
        }
        if (audioTrack != null) {
            audioTrack.setEnabled(false);
            audioTrack.dispose();
        }
        if (audioSource != null) {
            audioSource.dispose();
        }
        if (factory != null) {
            factory.dispose();
        }
        if (eglBase != null) {
            eglBase.release();
        }

        screenCapturer = null;
        textureHelper = null;
        videoSource = null;
        videoTrack = null;
        audioSource = null;
        audioTrack = null;
        factory = null;
        eglBase = null;
    }

    public static class SimpleSdpObserver
        implements SdpObserver {
        @Override
        public void onCreateSuccess(
            SessionDescription description
        ) {
        }

        @Override
        public void onSetSuccess() {
        }

        @Override
        public void onCreateFailure(String error) {
        }

        @Override
        public void onSetFailure(String error) {
        }
    }
}
