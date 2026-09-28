package com.p2pdesk.android;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.provider.OpenableColumns;

import org.json.JSONObject;

public class HostService extends Service
    implements WebRtcHost.Listener {

    public static final String EXTRA_CODE = "room_code";
    public static final String EXTRA_SIGNALING = "signaling_url";
    public static final String EXTRA_PROJECTION = "projection_data";
    public static final String EXTRA_ALLOW_CONTROL = "allow_control";
    public static final String EXTRA_SHARE_CLIPBOARD = "share_clipboard";
    public static final String EXTRA_SHARE_MICROPHONE = "share_microphone";

    private static final int NOTIFICATION_ID = 4101;
    private static final String CHANNEL_ID =
        "p2pdesk_remote";
    private static final int MAX_FILE_BYTES =
        25 * 1024 * 1024;
    private static final int MAX_FILE_CHUNK_BYTES =
        160 * 1024;

    private static volatile HostService instance;

    private SignalingClient signaling;
    private WebRtcHost host;
    private boolean allowControl;
    private boolean shareClipboard;
    private boolean shareMicrophone;

    private volatile String status = "OFFLINE";
    private volatile String lastError = "";

    private byte[][] incomingChunks;
    private String incomingFileId;
    private String incomingFileName;
    private int incomingTotal;
    private int incomingReceived;
    private int incomingBytes;
    private java.io.File lastReceivedFile;
    private volatile OutgoingFile outgoingFile;
    private long incomingSize;
    private final java.util.List<String> chatHistory =
        new java.util.concurrent.CopyOnWriteArrayList<>();

    private static final class OutgoingFile {
        final Uri uri;
        final String id;
        final String name;
        final String mime;
        final long size;
        final int totalChunks;

        OutgoingFile(
            Uri uri,
            String id,
            String name,
            String mime,
            long size,
            int totalChunks
        ) {
            this.uri = uri;
            this.id = id;
            this.name = name;
            this.mime = mime;
            this.size = size;
            this.totalChunks = totalChunks;
        }
    }

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

        shareMicrophone =
            intent.getBooleanExtra(
                EXTRA_SHARE_MICROPHONE,
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
                    this,
                    shareMicrophone
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

        if (Build.VERSION.SDK_INT >= 30) {
            int foregroundTypes =
                android.content.pm.ServiceInfo
                    .FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION;

            if (shareMicrophone) {
                foregroundTypes |=
                    android.content.pm.ServiceInfo
                        .FOREGROUND_SERVICE_TYPE_MICROPHONE;
            }

            startForeground(
                NOTIFICATION_ID,
                notification,
                foregroundTypes
            );
        } else if (Build.VERSION.SDK_INT >= 29) {
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

    private void handleInput(JSONObject message) {
        if (!allowControl) return;

        String type = message.optString("type");
        boolean success = false;

        if ("android_action".equals(type)) {
            success = RemoteAccessibilityService.systemAction(
                message.optString("action")
            );
        } else if ("mouse_button".equals(type)) {
            String action = message.optString("action");
            float x = (float) message.optDouble("x", 0.5);
            float y = (float) message.optDouble("y", 0.5);
            String button = message.optString("button");

            if ("right".equals(button) && "down".equals(action)) {
                success = RemoteAccessibilityService.longPress(x, y);
            } else if ("double".equals(action) && "left".equals(button)) {
                success = RemoteAccessibilityService.tap(x, y);
                if (success) {
                    try {
                        Thread.sleep(80L);
                    } catch (InterruptedException ignored) {
                        Thread.currentThread().interrupt();
                    }
                    success = RemoteAccessibilityService.tap(x, y);
                }
            } else if ("down".equals(action) && "left".equals(button)) {
                success = RemoteAccessibilityService.beginDrag(x, y);
            } else if ("down".equals(action) && "middle".equals(button)) {
                success = RemoteAccessibilityService.beginDrag(x, y);
            } else if ("up".equals(action)) {
                success = RemoteAccessibilityService.endDrag(x, y);
            }
        } else if ("mouse_move".equals(type)) {
            float x = (float) message.optDouble("x", 0.5);
            float y = (float) message.optDouble("y", 0.5);
            success = RemoteAccessibilityService.moveDrag(x, y);
        } else if ("scroll".equals(type)) {
            float x = (float) message.optDouble("x", 0.5);
            float y = (float) message.optDouble("y", 0.5);
            double dx = message.optDouble("deltaX", 0.0);
            double dy = message.optDouble("deltaY", 0.0);

            if (Math.abs(dx) > Math.abs(dy)) {
                float amount =
                    Math.max(
                        0.08f,
                        Math.min(
                            0.65f,
                            (float) Math.abs(dx) / 700f
                        )
                    );

                float endX = clampNorm(
                    x + (float) (dx > 0 ? -amount : amount)
                );

                success = RemoteAccessibilityService.swipe(
                    x, y, endX, y, 280L
                );
            } else {
                float amount =
                    Math.max(
                        0.08f,
                        Math.min(
                            0.65f,
                            (float) Math.abs(dy) / 700f
                        )
                    );

                float endY = clampNorm(
                    y + (float) (dy > 0 ? -amount : amount)
                );

                success = RemoteAccessibilityService.swipe(
                    x, y, x, endY, 280L
                );
            }
        } else if ("text_input".equals(type)) {
            success = RemoteAccessibilityService.setFocusedText(
                message.optString("text", "")
            );
        } else if ("keyboard".equals(type)) {
            org.json.JSONArray modifiers =
                message.optJSONArray("modifiers");

            boolean ctrl = hasModifier(modifiers, "CTRL");
            boolean shift = hasModifier(modifiers, "SHIFT");
            boolean alt = hasModifier(modifiers, "ALT");
            boolean meta = hasModifier(modifiers, "META");

            success = RemoteAccessibilityService.handleKey(
                message.optString("code"),
                message.optString("key"),
                "down".equals(message.optString("action")),
                ctrl,
                shift,
                alt,
                meta
            );
        }

        if (success) {
            setStatus("CONTROL_ACTIVE");
        } else if (
            !"mouse_move".equals(type) &&
            !"keyboard".equals(type)
        ) {
            setStatus("INPUT_UNAVAILABLE_" + type);
        }
    }

    private static boolean hasModifier(
        org.json.JSONArray modifiers,
        String value
    ) {
        if (modifiers == null) return false;

        for (int i = 0; i < modifiers.length(); i++) {
            if (value.equals(modifiers.optString(i))) {
                return true;
            }
        }

        return false;
    }

    private static float clampNorm(float value) {
        return Math.max(0f, Math.min(1f, value));
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

    private void handleFile(JSONObject message) throws Exception {
        String type = message.optString("type");

        if ("file_offer".equals(type)) {
            int size = message.optInt("size", -1);
            int chunks = message.optInt("totalChunks", -1);

            if (
                size < 0 ||
                size > MAX_FILE_BYTES ||
                chunks < 0 ||
                chunks > 512
            ) {
                return;
            }

            incomingFileId =
                message.optString("transferId");
            incomingFileName =
                sanitize(
                    message.optString("name", "download")
                );
            incomingSize = size;
            incomingTotal = chunks;
            incomingChunks = new byte[chunks][];
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

            if (incomingTotal == 0) {
                finalizeIncomingFile();
            } else {
                setStatus("FILE_RECEIVING");
            }
            return;
        }

        if ("file_accept".equals(type)) {
            OutgoingFile transfer = outgoingFile;

            if (
                transfer == null ||
                !transfer.id.equals(
                    message.optString("transferId")
                )
            ) {
                return;
            }

            new Thread(() -> sendOutgoingFile(transfer)).start();
            return;
        }

        if ("file_reject".equals(type)) {
            OutgoingFile transfer = outgoingFile;

            if (
                transfer != null &&
                transfer.id.equals(
                    message.optString("transferId")
                )
            ) {
                outgoingFile = null;
                setStatus("FILE_REJECTED");
            }
            return;
        }

        if (
            "file_chunk".equals(type) &&
            incomingChunks != null
        ) {
            int index =
                message.optInt("index", -1);

            if (
                index < 0 ||
                index >= incomingTotal ||
                incomingChunks[index] != null
            ) {
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

            if (bytes.length > MAX_FILE_CHUNK_BYTES) {
                incomingChunks = null;
                return;
            }

            incomingChunks[index] = bytes;
            incomingReceived++;
            incomingBytes += bytes.length;

            if (incomingBytes > incomingSize ||
                incomingBytes > MAX_FILE_BYTES) {
                incomingChunks = null;
                return;
            }

            setStatus(
                "FILE_RECEIVING_" +
                incomingReceived + "/" +
                incomingTotal
            );
            return;
        }

        if ("file_complete".equals(type)) {
            if (
                incomingChunks != null &&
                incomingReceived == incomingTotal
            ) {
                finalizeIncomingFile();
            }
        }
    }

    private void finalizeIncomingFile() throws Exception {
        if (incomingChunks == null) return;
        if (incomingReceived != incomingTotal) return;
        if (incomingBytes != incomingSize) {
            incomingChunks = null;
            setStatus("FILE_FAILED_SIZE");
            return;
        }

        java.io.File file =
            new java.io.File(
                getCacheDir(),
                incomingFileName
            );

        try (
            java.io.FileOutputStream output =
                new java.io.FileOutputStream(file)
        ) {
            for (byte[] chunk : incomingChunks) {
                if (chunk == null) return;
                output.write(chunk);
            }
        }

        lastReceivedFile = file;
        incomingChunks = null;
        setStatus("FILE_READY");
    }

    private void sendOutgoingFile(
        OutgoingFile transfer
    ) {
        try (
            java.io.InputStream input =
                getContentResolver()
                    .openInputStream(transfer.uri)
        ) {
            if (input == null) {
                throw new IllegalStateException(
                    "The selected file could not be opened."
                );
            }

            byte[] buffer =
                new byte[MAX_FILE_CHUNK_BYTES];

            for (int index = 0;
                 index < transfer.totalChunks;
                 index++) {

                int offset = 0;
                while (
                    offset < buffer.length
                ) {
                    int count =
                        input.read(
                            buffer,
                            offset,
                            buffer.length - offset
                        );

                    if (count < 0) break;
                    offset += count;

                    if (count == 0) break;
                }

                if (offset <= 0) {
                    throw new IllegalStateException(
                        "Unexpected end of selected file."
                    );
                }

                String encoded =
                    android.util.Base64
                        .encodeToString(
                            buffer,
                            0,
                            offset,
                            android.util.Base64.NO_WRAP
                        );

                if (
                    host == null ||
                    !host.send(
                        "file-transfer",
                        new JSONObject()
                            .put(
                                "type",
                                "file_chunk"
                            )
                            .put(
                                "transferId",
                                transfer.id
                            )
                            .put(
                                "index",
                                index
                            )
                            .put(
                                "data",
                                encoded
                            )
                    )
                ) {
                    throw new IllegalStateException(
                        "The file-transfer channel closed."
                    );
                }

                setStatus(
                    "FILE_SENDING_" +
                    (index + 1) + "/" +
                    transfer.totalChunks
                );
            }

            if (
                host == null ||
                !host.send(
                    "file-transfer",
                    new JSONObject()
                        .put(
                            "type",
                            "file_complete"
                        )
                        .put(
                            "transferId",
                            transfer.id
                        )
                )
            ) {
                throw new IllegalStateException(
                    "The file completion message could not be sent."
                );
            }

            setStatus("FILE_SENT");
        } catch (Exception error) {
            fail(
                "Android file send failed: " +
                error.getMessage()
            );
        } finally {
            if (outgoingFile == transfer) {
                outgoingFile = null;
            }
        }
    }

    private void handleChat(JSONObject message) {
        if (!"chat_message".equals(
            message.optString("type")
        )) {
            return;
        }

        String text =
            message.optString("text", "").trim();

        if (text.isEmpty()) return;

        chatHistory.add("PC: " + text);

        while (chatHistory.size() > 40) {
            chatHistory.remove(0);
        }

        setStatus("CHAT_RECEIVED");
    }

    public boolean sendChat(
        String text
    ) {
        if (
            host == null ||
            text == null ||
            text.trim().isEmpty()
        ) {
            return false;
        }

        String value = text.trim();

        try {
            boolean sent =
                host.send(
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
                            value
                        )
                        .put(
                            "sentAt",
                            System.currentTimeMillis()
                        )
                );

            if (sent) {
                chatHistory.add("PHONE: " + value);
                while (chatHistory.size() > 40) {
                    chatHistory.remove(0);
                }
            }

            return sent;
        } catch (Exception error) {
            fail(error.getMessage());
            return false;
        }
    }

    public String getChatTranscript() {
        return String.join("\n", chatHistory);
    }

    public boolean sendFileToPeer(Uri uri) {
        if (host == null || uri == null) return false;

        try {
            long size = queryFileSize(uri);

            if (size < 0 || size > MAX_FILE_BYTES) {
                setStatus("FILE_REJECTED_SIZE");
                return false;
            }

            String name = queryFileName(uri);
            if (name == null || name.trim().isEmpty()) {
                name = "upload";
            }

            name = sanitize(name);

            String mime =
                getContentResolver().getType(uri);

            if (mime == null) {
                mime = "application/octet-stream";
            }

            int totalChunks =
                size == 0
                    ? 0
                    : (int) Math.ceil(
                        (double) size /
                        MAX_FILE_CHUNK_BYTES
                    );

            if (totalChunks > 512) {
                setStatus("FILE_REJECTED_CHUNKS");
                return false;
            }

            String id =
                java.util.UUID
                    .randomUUID()
                    .toString()
                    .replace("-", "");

            OutgoingFile transfer =
                new OutgoingFile(
                    uri,
                    id,
                    name,
                    mime,
                    size,
                    totalChunks
                );

            outgoingFile = transfer;

            boolean sent =
                host.send(
                    "file-transfer",
                    new JSONObject()
                        .put(
                            "type",
                            "file_offer"
                        )
                        .put(
                            "transferId",
                            id
                        )
                        .put(
                            "name",
                            name
                        )
                        .put(
                            "mime",
                            mime
                        )
                        .put(
                            "size",
                            size
                        )
                        .put(
                            "totalChunks",
                            totalChunks
                        )
                );

            if (!sent) {
                outgoingFile = null;
                return false;
            }

            setStatus("FILE_OFFER_SENT");
            return true;
        } catch (Exception error) {
            fail(
                "Android file offer failed: " +
                error.getMessage()
            );
            return false;
        }
    }

    private long queryFileSize(Uri uri) {
        try (
            Cursor cursor =
                getContentResolver().query(
                    uri,
                    new String[]{OpenableColumns.SIZE},
                    null,
                    null,
                    null
                )
        ) {
            if (
                cursor != null &&
                cursor.moveToFirst() &&
                !cursor.isNull(0)
            ) {
                return cursor.getLong(0);
            }
        } catch (Exception ignored) {
        }

        return -1;
    }

    private String queryFileName(Uri uri) {
        try (
            Cursor cursor =
                getContentResolver().query(
                    uri,
                    new String[]{OpenableColumns.DISPLAY_NAME},
                    null,
                    null,
                    null
                )
        ) {
            if (
                cursor != null &&
                cursor.moveToFirst()
            ) {
                return cursor.getString(0);
            }
        } catch (Exception ignored) {
        }

        return null;
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
