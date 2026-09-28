package com.p2pdesk.android;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Path;
import android.graphics.Point;
import android.os.Bundle;
import android.view.Display;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityNodeInfo;

public class RemoteAccessibilityService extends AccessibilityService {
    private static volatile RemoteAccessibilityService instance;

    public static boolean isAvailable() {
        return instance != null;
    }

    public static boolean tap(float x, float y) {
        RemoteAccessibilityService service = instance;
        return service != null && service.dispatchTap(x, y, 70L);
    }

    public static boolean longPress(float x, float y) {
        RemoteAccessibilityService service = instance;
        return service != null && service.dispatchTap(x, y, 650L);
    }

    public static boolean swipe(
        float x1,
        float y1,
        float x2,
        float y2,
        long durationMs
    ) {
        RemoteAccessibilityService service = instance;
        return service != null &&
            service.dispatchSwipe(x1, y1, x2, y2, durationMs);
    }

    public static boolean globalBack() {
        RemoteAccessibilityService service = instance;
        return service != null &&
            service.performGlobalAction(GLOBAL_ACTION_BACK);
    }

    public static boolean globalHome() {
        RemoteAccessibilityService service = instance;
        return service != null &&
            service.performGlobalAction(GLOBAL_ACTION_HOME);
    }

    public static boolean globalRecents() {
        RemoteAccessibilityService service = instance;
        return service != null &&
            service.performGlobalAction(GLOBAL_ACTION_RECENTS);
    }

    public static boolean setFocusedText(String text) {
        RemoteAccessibilityService service = instance;
        return service != null && service.replaceFocusedText(text);
    }

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
    }

    @Override
    public void onDestroy() {
        instance = null;
        super.onDestroy();
    }

    @Override
    public void onAccessibilityEvent(
        android.view.accessibility.AccessibilityEvent event
    ) {
    }

    @Override
    public void onInterrupt() {
    }

    private Point displaySize() {
        WindowManager manager =
            (WindowManager) getSystemService(WINDOW_SERVICE);
        Display display = manager.getDefaultDisplay();
        Point size = new Point();
        display.getRealSize(size);
        return size;
    }

    private boolean dispatchTap(
        float xNorm,
        float yNorm,
        long durationMs
    ) {
        Point size = displaySize();

        float x =
            clamp(xNorm, 0f, 1f) * Math.max(1, size.x - 1);
        float y =
            clamp(yNorm, 0f, 1f) * Math.max(1, size.y - 1);

        Path path = new Path();
        path.moveTo(x, y);

        GestureDescription.StrokeDescription stroke =
            new GestureDescription.StrokeDescription(
                path,
                0,
                durationMs
            );

        return dispatchGesture(
            new GestureDescription.Builder()
                .addStroke(stroke)
                .build(),
            null,
            null
        );
    }

    private boolean dispatchSwipe(
        float x1,
        float y1,
        float x2,
        float y2,
        long durationMs
    ) {
        Point size = displaySize();

        float startX =
            clamp(x1, 0f, 1f) * Math.max(1, size.x - 1);
        float startY =
            clamp(y1, 0f, 1f) * Math.max(1, size.y - 1);
        float endX =
            clamp(x2, 0f, 1f) * Math.max(1, size.x - 1);
        float endY =
            clamp(y2, 0f, 1f) * Math.max(1, size.y - 1);

        Path path = new Path();
        path.moveTo(startX, startY);
        path.lineTo(endX, endY);

        GestureDescription.StrokeDescription stroke =
            new GestureDescription.StrokeDescription(
                path,
                0,
                Math.max(80L, durationMs)
            );

        return dispatchGesture(
            new GestureDescription.Builder()
                .addStroke(stroke)
                .build(),
            null,
            null
        );
    }

    private boolean replaceFocusedText(String text) {
        AccessibilityNodeInfo root =
            getRootInActiveWindow();

        if (root == null) return false;

        AccessibilityNodeInfo focused =
            root.findFocus(
                AccessibilityNodeInfo.FOCUS_INPUT
            );

        if (focused == null) {
            focused = findEditable(root);
        }

        if (focused == null) {
            root.recycle();
            return false;
        }

        Bundle args = new Bundle();
        args.putCharSequence(
            AccessibilityNodeInfo
                .ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
            text
        );

        boolean result = focused.performAction(
            AccessibilityNodeInfo.ACTION_SET_TEXT,
            args
        );

        if (focused != root) {
            focused.recycle();
        }
        root.recycle();
        return result;
    }

    private AccessibilityNodeInfo findEditable(
        AccessibilityNodeInfo node
    ) {
        if (node == null) return null;
        if (node.isEditable() && node.isVisibleToUser()) {
            return node;
        }

        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            AccessibilityNodeInfo result = findEditable(child);

            if (result != null) return result;
            if (child != null) child.recycle();
        }

        return null;
    }

    private static float clamp(
        float value,
        float min,
        float max
    ) {
        return Math.max(min, Math.min(max, value));
    }
}
