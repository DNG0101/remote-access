package com.p2pdesk.android;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

public class MainActivity extends Activity {
    private static final int REQUEST_CAPTURE = 8201;
    private static final int REQUEST_SAVE = 8301;

    private EditText codeInput;
    private EditText signalingInput;
    private CheckBox controlCheckbox;
    private CheckBox clipboardCheckbox;
    private TextView statusText;
    private TextView accessText;
    private String pendingFilePath = "";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        if (
            Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(
                Manifest.permission.POST_NOTIFICATIONS
            ) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(
                new String[]{
                    Manifest.permission.POST_NOTIFICATIONS
                },
                8202
            );
        }

        buildUi();
        refreshStatus();
    }

    private void buildUi() {
        ScrollView scroll = new ScrollView(this);

        LinearLayout root =
            new LinearLayout(this);
        root.setOrientation(
            LinearLayout.VERTICAL
        );
        root.setPadding(
            36, 42, 36, 42
        );
        scroll.addView(root);

        root.addView(
            text(
                "P2P Desk — Android Host",
                28
            )
        );

        root.addView(
            text(
                "Use this native app on the Android phone you want to control from your PC.",
                16
            )
        );

        root.addView(
            text(
                "6-digit session code",
                13
            )
        );

        codeInput = new EditText(this);
        codeInput.setHint("000000");
        codeInput.setInputType(
            android.text.InputType.TYPE_CLASS_NUMBER
        );
        codeInput.setMaxLength(6);
        root.addView(
            codeInput,
            fieldParams()
        );

        root.addView(
            text(
                "Signaling WSS URL",
                13
            )
        );

        signalingInput = new EditText(this);
        signalingInput.setSingleLine(true);
        signalingInput.setText(
            "wss://wss.getlost.ovh"
        );
        root.addView(
            signalingInput,
            fieldParams()
        );

        controlCheckbox = new CheckBox(this);
        controlCheckbox.setText(
            "Allow PC to control this phone"
        );
        controlCheckbox.setChecked(false);
        root.addView(controlCheckbox);

        clipboardCheckbox =
            new CheckBox(this);
        clipboardCheckbox.setText(
            "Allow clipboard sharing"
        );
        clipboardCheckbox.setChecked(false);
        root.addView(clipboardCheckbox);

        Button accessibilityButton =
            new Button(this);

        accessibilityButton.setText(
            "1. Enable Android accessibility service"
        );

        accessibilityButton.setOnClickListener(
            view -> startActivity(
                new Intent(
                    Settings.ACTION_ACCESSIBILITY_SETTINGS
                )
            )
        );

        root.addView(
            accessibilityButton
        );

        accessText = text("", 14);
        root.addView(accessText);

        Button start = new Button(this);
        start.setText(
            "2. Start Android host"
        );
        start.setOnClickListener(
            view -> requestCapture()
        );
        root.addView(start);

        Button stop = new Button(this);
        stop.setText(
            "Stop remote session"
        );
        stop.setOnClickListener(view -> {
            HostService service =
                HostService.getInstance();

            if (service != null) {
                service.stopHosting();
            }
        });
        root.addView(stop);

        Button clipboard =
            new Button(this);
        clipboard.setText(
            "Send phone clipboard to PC"
        );
        clipboard.setOnClickListener(view -> {
            HostService service =
                HostService.getInstance();

            if (service != null) {
                service.sendClipboardToPeer();
            }
        });
        root.addView(clipboard);

        Button saveFile =
            new Button(this);
        saveFile.setText(
            "Save last received file"
        );
        saveFile.setOnClickListener(
            view -> saveLastFile()
        );
        root.addView(saveFile);

        Button testChat =
            new Button(this);
        testChat.setText(
            "Send test chat to PC"
        );
        testChat.setOnClickListener(view -> {
            HostService service =
                HostService.getInstance();

            if (service != null) {
                service.sendChat(
                    "Hello from Android host"
                );
            }
        });
        root.addView(testChat);

        statusText = text(
            "Status: OFFLINE",
            18
        );
        statusText.setGravity(
            Gravity.CENTER_HORIZONTAL
        );
        root.addView(statusText);

        root.addView(
            text(
                "On the PC: open the web client, choose Controller, enter the same code, join, request control, then use the remote screen. Click = tap, right click = long press, wheel = scroll, and the web mobile keyboard sends text to the focused Android field.",
                14
            )
        );

        setContentView(scroll);
    }

    private void requestCapture() {
        String code =
            codeInput.getText()
                .toString()
                .replaceAll("\D", "");

        if (!code.matches("\d{6}")) {
            codeInput.setError(
                "Enter a 6-digit session code."
            );
            return;
        }

        MediaProjectionManager manager =
            (MediaProjectionManager)
                getSystemService(
                    MEDIA_PROJECTION_SERVICE
                );

        startActivityForResult(
            manager.createScreenCaptureIntent(),
            REQUEST_CAPTURE
        );
    }

    @Override
    protected void onActivityResult(
        int requestCode,
        int resultCode,
        Intent data
    ) {
        super.onActivityResult(
            requestCode,
            resultCode,
            data
        );

        if (requestCode == REQUEST_CAPTURE) {
            if (
                resultCode != RESULT_OK ||
                data == null
            ) {
                return;
            }

            startHostService(
                codeInput.getText()
                    .toString()
                    .replaceAll("\D", ""),
                data
            );
            return;
        }

        if (requestCode == REQUEST_SAVE) {
            if (
                resultCode != RESULT_OK ||
                data == null ||
                pendingFilePath.isEmpty()
            ) {
                return;
            }

            Uri destination = data;
            String sourcePath =
                pendingFilePath;

            pendingFilePath = "";

            new Thread(() -> {
                try (
                    java.io.InputStream input =
                        new java.io.FileInputStream(
                            sourcePath
                        );
                    java.io.OutputStream output =
                        getContentResolver()
                            .openOutputStream(
                                destination
                            )
                ) {
                    if (output == null) return;

                    byte[] buffer =
                        new byte[8192];

                    int count;
                    while (
                        (count =
                            input.read(buffer)) > 0
                    ) {
                        output.write(
                            buffer,
                            0,
                            count
                        );
                    }
                } catch (Exception ignored) {
                }
            }).start();
        }
    }

    private void startHostService(
        String code,
        Intent projection
    ) {
        Intent service =
            new Intent(
                this,
                HostService.class
            )
                .putExtra(
                    HostService.EXTRA_CODE,
                    code
                )
                .putExtra(
                    HostService.EXTRA_SIGNALING,
                    signalingInput.getText()
                        .toString()
                        .trim()
                )
                .putExtra(
                    HostService.EXTRA_PROJECTION,
                    projection
                )
                .putExtra(
                    HostService.EXTRA_ALLOW_CONTROL,
                    controlCheckbox.isChecked()
                )
                .putExtra(
                    HostService.EXTRA_SHARE_CLIPBOARD,
                    clipboardCheckbox.isChecked()
                );

        if (Build.VERSION.SDK_INT >= 26) {
            startForegroundService(service);
        } else {
            startService(service);
        }
    }

    private void saveLastFile() {
        HostService service =
            HostService.getInstance();

        if (service == null) return;

        String sourcePath =
            service.getLastReceivedFilePath();

        if (sourcePath.isEmpty()) return;

        pendingFilePath =
            sourcePath;

        Intent intent =
            new Intent(
                Intent.ACTION_CREATE_DOCUMENT
            )
                .setType("*/*")
                .putExtra(
                    Intent.EXTRA_TITLE,
                    new java.io.File(
                        sourcePath
                    ).getName()
                );

        startActivityForResult(
            intent,
            REQUEST_SAVE
        );
    }

    @Override
    protected void onResume() {
        super.onResume();
        refreshStatus();
    }

    private void refreshStatus() {
        if (statusText == null) return;

        String error =
            HostService.getLastError();

        statusText.setText(
            "Status: " +
            HostService.getStatusText() +
            (
                error.isEmpty()
                    ? ""
                    : "\nError: " + error
            )
        );

        if (accessText != null) {
            accessText.setText(
                RemoteAccessibilityService
                    .isAvailable()
                    ? "Accessibility bridge: READY"
                    : "Accessibility bridge: NOT ENABLED — remote taps/text will not work until Android accessibility is enabled."
            );
        }
    }

    private TextView text(
        String value,
        int sizeSp
    ) {
        TextView view =
            new TextView(this);

        view.setText(value);
        view.setTextSize(sizeSp);
        view.setPadding(
            0, 10, 0, 10
        );

        return view;
    }

    private LinearLayout.LayoutParams fieldParams() {
        return new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
    }
}
