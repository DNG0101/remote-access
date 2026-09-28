package com.p2pdesk.android;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

import org.json.JSONObject;

public class HostService extends Service
    implements WebRtcHost.Listener {

    public static final String EXTRA_CODE = "room_code";
    public static final String EXTRA_SIGNALING = "signaling_url";
    public static final String EXTRA_PROJECTION = "projection_data";
    public static final String EXTRA_ALLOW_CONTROL = "allow_control";
    public static final String EXTRA_SHARE_CLIPBOARD = "share_clipboard";

    private static final int NOTIFICATION_ID = 4101;
    private static final String CHANNEL_ID =
        "p2pdesk_remote";
    private static final int MAX_FILE_BYTES =
        25 * 1024 * 1024;

    private static volatile HostService instance;

    private SignalingClient signaling;
    private WebRtcHost host;
    private boolean allowControl;
    private boolean shareClipboard;

    private volatile String status = "OFFLINE";
    private volatile String lastError = "";

    private byte[][] incomingChunks;
    private String incomingFileId;
    private String incomingFileName;
    private int incomingTotal;
    private int incomingReceived;
    private int incomingBytes;
    private java.io.File lastReceivedFile;

    public static HostService getInstance() {
        return instance;
    }

    public static String getStatusText() {
        HostService service = instance;
        return service == null
            ? "OFFLINE"
            : service.status;
    }

    public static String getLastError() {
        HostService service = instance;
        return service == null
            ? ""
            : service.lastError;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(
        Intent intent,
        int flags,
        int startId
    ) {
        if (intent == null) {
            return START_NOT_STICKY;
        }

        String code =
            intent.getStringExtra(EXTRA_CODE);
        String signalingUrl =
            intent.getStringExtra(EXTRA_SIGNALING);
        Intent projection =
            getProjectionExtra(intent);

        allowControl =
            intent.getBooleanExtra(
                EXTRA_ALLOW_CONTROL,
                false
            );

        shareClipboard =
            intent.getBooleanExtra(
                EXTRA_SHARE_CLIPBOARD,
                false
            );

        if (code == null ||
            !code.matches("\\d{6}") ||
            signalingUrl == null ||
            projection == null) {
            fail("Invalid Android host configuration.");
            return START_NOT_STICKY;
        }

        ensureForeground();

        if (host != null) {
            return START_STICKY;
        }

        try {
            signaling =
                new SignalingClient(
                    signalingUrl,
                    code,
                    new SignalingClient.Listener() {
                        @Override
                        public void onConnected() {
                            setStatus(
                                "SIGNALING_CONNECTED"
                            );
                        }

                        @Override
                        public void onPeerJoined(
                            String peerId
                        ) {
                            if (host != null) {
                                setStatus("PEER_JOINING");
                                host.onPeerJoined(peerId);
                            }
                        }

                        @Override
                        public void onSignal(
                            JSONObject message
                        ) {
                            if (host != null) {
                                host.onSignal(message);
                            }
                        }

                        @Override
                        public void onError(
                            String message
                        ) {
                            fail(message);
                        }

                        @Override
                        public void onClosed() {
                            setStatus(
                                "SIGNALING_CLOSED"
                            );
                        }
                    }
                );

            host =
                new WebRtcHost(
                    this,
                    signaling,
                    this
                );

            host.start(projection);
        } catch (Exception error) {
            fail(error.getMessage());
        }

        return START_STICKY;
    }

    private Intent getProjectionExtra(
        Intent source
    ) {
        if (Build.VERSION.SDK_INT >= 33) {
            return source.getParcelableExtra(
                EXTRA_PROJECTION,
                Intent.class
            );
        }

        return source.getParcelableExtra(
            EXTRA_PROJECTION
        );
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < 26) return;

        NotificationChannel channel =
            new NotificationChannel(
                CHANNEL_ID,
                getString(
                    R.string.screen_capture_channel
                ),
                NotificationManager.IMPORTANCE_LOW
            );

        NotificationManager manager =
            (NotificationManager)
                getSystemService(NOTIFICATION_SERVICE);

        manager.createNotificationChannel(channel);
    }

    private Notification buildNotification() {
        if (Build.VERSION.SDK_INT >= 26) {
            return new Notification.Builder(
                this,
                CHANNEL_ID
            )
                .setContentTitle(
                    getString(
                        R.string.screen_capture_notification
                    )
                )
                .setContentText(status)
                .setSmallIcon(
                    android.R.drawable
                        .presence_video_online
                )
                .setOngoing(true)
                .build();
        }

        return new Notification.Builder(this)
            .setContentTitle("P2P Desk")
            .setContentText(status)
            .setSmallIcon(
                android.R.drawable
                    .presence_video_online
            )
            .setOngoing(true)
            .build();
    }

    private void ensureForeground() {
        Notification notification =
            buildNotification();

        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                android.content.pm.ServiceInfo
                    .FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            );
        } else {
            startForeground(
                NOTIFICATION_ID,
                notification
            );
        }
    }

    private void setStatus(String value) {
        status = value == null
            ? "UNKNOWN"
            : value;

        NotificationManager manager =
            (NotificationManager)
                getSystemService(
                    NOTIFICATION_SERVICE
                );

        if (manager != null) {
            manager.notify(
                NOTIFICATION_ID,
                buildNotification()
            );
        }
    }

    private void fail(String message) {
        lastError =
            message == null
                ? "Unknown Android host error."
                : message;
        setStatus("FAILED");
    }

    @Override
    public void onState(String value) {
        setStatus(value);
    }

    @Override
    public void onError(String message) {
        fail(message);
    }

    @Override
    public void onMessage(
        String channel,
        JSONObject message
    ) {
        try {
            if ("control".equals(channel)) {
                handleControl(message);
            } else if ("input".equals(channel)) {
                handleInput(message);
            } else if ("clipboard".equals(channel)) {
                handleClipboard(message);
            } else if ("file-transfer".equals(channel)) {
                handleFile(message);
            } else if ("chat".equals(channel)) {
                setStatus("CHAT_RECEIVED");
            }
        } catch (Exception error) {
            fail(
                "Module error: " +
                error.getMessage()
            );
        }
    }

    private void handleControl(
        JSONObject message
    ) throws Exception {
        String type =
            message.optString("type");

        if ("screen_stopped".equals(type)) {
            if (host != null) {
                host.send("control", message);
            }
            setStatus("SCREEN_STOPPED");
            return;
        }

        if (!"control_request".equals(type) ||
            host == null) {
            return;
        }

        boolean granted =
            allowControl &&
            RemoteAccessibilityService
                .isAvailable();

        JSONObject decision =
            new JSONObject()
                .put(
                    "type",
                    "control_decision"
                )
                .put(
                    "requestId",
                    message.optString("requestId")
                )
                .put(
                    "granted",
                    granted
                );

        host.send(
            "control",
            decision
        );

        setStatus(
            granted
                ? "CONTROL_GRANTED"
                : "CONTROL_DENIED"
        );
    }

    private void handleInput(
        JSONObject message
    ) {
        if (!allowControl) return;

        String type =
            message.optString("type");

        boolean success = false;

        if ("mouse_button".equals(type)) {
            String action =
                message.optString("action");

            if ("down".equals(action) ||
                "double".equals(action)) {
                float x =
                    (float)
                        message.optDouble(
                            "x",
                            0.5
                        );
                float y =
                    (float)
                        message.optDouble(
                            "y",
                            0.5
                        );

                String button =
                    message.optString(
                        "button"
                    );

                if ("right".equals(button)) {
                    success =
                        RemoteAccessibilityService
                            .longPress(x, y);
                } else {
                    success =
                        RemoteAccessibilityService
                            .tap(x, y);

                    if ("double".equals(action)) {
                        try {
                            Thread.sleep(90L);
                        } catch (
                            InterruptedException ignored
                        ) {
                            Thread.currentThread()
                                .interrupt();
                        }

                        success =
                            RemoteAccessibilityService
                                .tap(x, y);
                    }
                }
            }
        } else if ("scroll".equals(type)) {
            double dy =
                message.optDouble(
                    "deltaY",
                    0.0
                );

            float startY =
                dy > 0
                    ? 0.68f
                    : 0.32f;
            float endY =
                dy > 0
                    ? 0.32f
                    : 0.68f;

            success =
                RemoteAccessibilityService
                    .swipe(
                        0.5f,
                        startY,
                        0.5f,
                        endY,
                        380L
                    );
        } else if ("text_input".equals(type)) {
            success =
                RemoteAccessibilityService
                    .setFocusedText(
                        message.optString(
                            "text",
                            ""
                        )
                    );
        } else if (
            "keyboard".equals(type) &&
            "down".equals(
                message.optString(
                    "action"
                )
            )
        ) {
            String code =
                message.optString("code");

            if ("Escape".equals(code) ||
                "Backspace".equals(code) &&
                message.optString("key").isEmpty()) {
                success =
                    RemoteAccessibilityService
                        .globalBack();
            } else if ("Home".equals(code)) {
                success =
                    RemoteAccessibilityService
                        .globalHome();
            } else if ("F6".equals(code)) {
                success =
                    RemoteAccessibilityService
                        .globalRecents();
            }
        } else if ("mouse_move".equals(type)) {
            success = true;
        }

        if (success) {
            setStatus("CONTROL_ACTIVE");
        } else if (!"mouse_move".equals(type)) {
            setStatus(
                "INPUT_UNAVAILABLE_" +
                type
            );
        }
    }

    private void handleClipboard(
        JSONObject message
    ) {
        if (!"clipboard_text".equals(
            message.optString("type")
        )) {
            return;
        }

        ClipboardManager clipboard =
            (ClipboardManager)
                getSystemService(
                    CLIPBOARD_SERVICE
                );

        clipboard.setPrimaryClip(
            ClipData.newPlainText(
                "P2P Desk",
                message.optString(
                    "text",
                    ""
                )
            )
        );

        setStatus("CLIPBOARD_RECEIVED");
    }

    private void handleFile(
        JSONObject message
    ) throws Exception {
        String type =
            message.optString("type");

        if ("file_offer".equals(type)) {
            int size =
                message.optInt(
                    "size",
                    -1
                );
            int chunks =
                message.optInt(
                    "totalChunks",
                    -1
                );

            if (size < 0 ||
                size > MAX_FILE_BYTES ||
                chunks < 0 ||
                chunks > 512) {
                return;
            }

            incomingFileId =
                message.optString(
                    "transferId"
                );

            incomingFileName =
                sanitize(
                    message.optString(
                        "name",
                        "download"
                    )
                );

            incomingTotal = chunks;
            incomingChunks =
                new byte[chunks][];

            incomingReceived = 0;
            incomingBytes = 0;

            if (host != null) {
                host.send(
                    "file-transfer",
                    new JSONObject()
                        .put(
                            "type",
                            "file_accept"
                        )
                        .put(
                            "transferId",
                            incomingFileId
                        )
                );
            }

            setStatus("FILE_RECEIVING");
            return;
        }

        if ("file_chunk".equals(type) &&
            incomingChunks != null) {
            int index =
                message.optInt(
                    "index",
                    -1
                );

            if (index < 0 ||
                index >= incomingTotal ||
                incomingChunks[index] != null) {
                return;
            }

            byte[] bytes =
                java.util.Base64
                    .getDecoder()
                    .decode(
                        message.optString(
                            "data",
                            ""
                        )
                    );

            incomingChunks[index] = bytes;
            incomingReceived++;
            incomingBytes += bytes.length;

            if (incomingBytes > MAX_FILE_BYTES) {
                incomingChunks = null;
                return;
            }

            if (incomingReceived == incomingTotal) {
                java.io.File file =
                    new java.io.File(
                        getCacheDir(),
                        incomingFileName
                    );

                try (
                    java.io.FileOutputStream output =
                        new java.io.FileOutputStream(
                            file
                        )
                ) {
                    for (byte[] chunk :
                        incomingChunks) {
                        if (chunk == null) return;
                        output.write(chunk);
                    }
                }

                lastReceivedFile = file;
                incomingChunks = null;
                setStatus("FILE_READY");
            }
        }
    }

    public boolean sendChat(
        String text
    ) {
        if (host == null ||
            text == null ||
            text.trim().isEmpty()) {
            return false;
        }

        try {
            return host.send(
                "chat",
                new JSONObject()
                    .put(
                        "type",
                        "chat_message"
                    )
                    .put(
                        "messageId",
                        java.util.UUID
                            .randomUUID()
                            .toString()
                    )
                    .put(
                        "text",
                        text.trim()
                    )
                    .put(
                        "sentAt",
                        System.currentTimeMillis()
                    )
            );
        } catch (Exception error) {
            fail(error.getMessage());
            return false;
        }
    }

    public boolean sendClipboardToPeer() {
        if (host == null ||
            !shareClipboard) {
            return false;
        }

        ClipboardManager clipboard =
            (ClipboardManager)
                getSystemService(
                    CLIPBOARD_SERVICE
                );

        if (!clipboard.hasPrimaryClip()) {
            return false;
        }

        ClipData clip =
            clipboard.getPrimaryClip();

        if (clip == null ||
            clip.getItemCount() == 0) {
            return false;
        }

        CharSequence value =
            clip.getItemAt(0).coerceToText(this);

        if (value == null) return false;

        try {
            return host.send(
                "clipboard",
                new JSONObject()
                    .put(
                        "type",
                        "clipboard_text"
                    )
                    .put(
                        "text",
                        value.toString()
                    )
            );
        } catch (Exception error) {
            fail(error.getMessage());
            return false;
        }
    }

    public String getLastReceivedFilePath() {
        return lastReceivedFile == null
            ? ""
            : lastReceivedFile.getAbsolutePath();
    }

    public void stopHosting() {
        stopSelf();
    }

    @Override
    public void onDestroy() {
        if (signaling != null) signaling.close();
        if (host != null) host.stop();

        instance = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private static String sanitize(String name) {
        String result = name == null ? "" : name;
        String[] invalid = {
            "\\", "/", ":", "*", "?", "\"", "<", ">", "|"
        };

        for (String item : invalid) {
            result = result.replace(item, "_");
        }

        return result.isEmpty() ? "download" : result;
    }
}
