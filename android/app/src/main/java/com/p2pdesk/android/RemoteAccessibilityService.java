package com.p2pdesk.android;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.graphics.Path;
import android.graphics.Point;
import android.os.Build;
import android.os.Bundle;
import android.view.Display;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityNodeInfo;

public class RemoteAccessibilityService extends AccessibilityService {
    private static volatile RemoteAccessibilityService instance;

    private GestureDescription.StrokeDescription activeStroke;
    private float activeX;
    private float activeY;
    private boolean dragActive;

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

    public static boolean beginDrag(float x, float y) {
        RemoteAccessibilityService service = instance;
        return service != null && service.startDrag(x, y);
    }

    public static boolean moveDrag(float x, float y) {
        RemoteAccessibilityService service = instance;
        return service != null && service.updateDrag(x, y);
    }

    public static boolean endDrag(float x, float y) {
        RemoteAccessibilityService service = instance;
        return service != null && service.finishDrag(x, y);
    }

    public static boolean cancelDrag() {
        RemoteAccessibilityService service = instance;
        return service != null && service.finishDrag(
            service.activeX,
            service.activeY
        );
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
            service.dispatchSwipe(
                x1,
                y1,
                x2,
                y2,
                durationMs
            );
    }

    public static boolean globalBack() {
        RemoteAccessibilityService service = instance;
        return service != null &&
            service.performGlobalAction(
                GLOBAL_ACTION_BACK
            );
    }

    public static boolean globalHome() {
        RemoteAccessibilityService service = instance;
        return service != null &&
            service.performGlobalAction(
                GLOBAL_ACTION_HOME
            );
    }

    public static boolean globalRecents() {
        RemoteAccessibilityService service = instance;
        return service != null &&
            service.performGlobalAction(
                GLOBAL_ACTION_RECENTS
            );
    }

    public static boolean setFocusedText(String text) {
        RemoteAccessibilityService service = instance;
        return service != null &&
            service.replaceSelection(text, false);
    }

    public static boolean handleKey(
        String code,
        String key,
        boolean down,
        boolean ctrl,
        boolean shift,
        boolean alt,
        boolean meta
    ) {
        RemoteAccessibilityService service = instance;

        if (service == null) return false;
        if (!down) return true;

        return service.performKey(
            code,
            key,
            ctrl,
            shift
        );
    }

    public static boolean systemAction(String action) {
        RemoteAccessibilityService service = instance;
        return service != null && service.performSystemAction(action);
    }

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
    }

    @Override
    public void onDestroy() {
        cancelDrag();
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
        cancelDrag();
    }

    private Point displaySize() {
        WindowManager manager =
            (WindowManager) getSystemService(
                WINDOW_SERVICE
            );
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
            clamp(xNorm, 0f, 1f) *
            Math.max(1, size.x - 1);
        float y =
            clamp(yNorm, 0f, 1f) *
            Math.max(1, size.y - 1);

        Path path = new Path();
        path.moveTo(x, y);

        GestureDescription.StrokeDescription stroke =
            new GestureDescription.StrokeDescription(
                path,
                0,
                Math.max(1L, durationMs)
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
            clamp(x1, 0f, 1f) *
            Math.max(1, size.x - 1);
        float startY =
            clamp(y1, 0f, 1f) *
            Math.max(1, size.y - 1);
        float endX =
            clamp(x2, 0f, 1f) *
            Math.max(1, size.x - 1);
        float endY =
            clamp(y2, 0f, 1f) *
            Math.max(1, size.y - 1);

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

    private boolean startDrag(
        float xNorm,
        float yNorm
    ) {
        if (dragActive) {
            finishDrag(activeX, activeY);
        }

        Point size = displaySize();
        activeX =
            clamp(xNorm, 0f, 1f) *
            Math.max(1, size.x - 1);
        activeY =
            clamp(yNorm, 0f, 1f) *
            Math.max(1, size.y - 1);

        Path path = new Path();
        path.moveTo(activeX, activeY);

        GestureDescription.StrokeDescription stroke =
            new GestureDescription.StrokeDescription(
                path,
                0,
                10L,
                true
            );

        boolean accepted = dispatchGesture(
            new GestureDescription.Builder()
                .addStroke(stroke)
                .build(),
            null,
            null
        );

        if (!accepted) {
            activeStroke = null;
            dragActive = false;
            return false;
        }

        activeStroke = stroke;
        dragActive = true;
        return true;
    }

    private boolean updateDrag(
        float xNorm,
        float yNorm
    ) {
        if (!dragActive || activeStroke == null) {
            return false;
        }

        Point size = displaySize();
        float nextX =
            clamp(xNorm, 0f, 1f) *
            Math.max(1, size.x - 1);
        float nextY =
            clamp(yNorm, 0f, 1f) *
            Math.max(1, size.y - 1);

        if (
            Math.abs(nextX - activeX) < 1f &&
            Math.abs(nextY - activeY) < 1f
        ) {
            return true;
        }

        Path path = new Path();
        path.moveTo(activeX, activeY);
        path.lineTo(nextX, nextY);

        GestureDescription.StrokeDescription next =
            activeStroke.continueStroke(
                path,
                0,
                40L,
                true
            );

        boolean accepted = dispatchGesture(
            new GestureDescription.Builder()
                .addStroke(next)
                .build(),
            null,
            null
        );

        if (!accepted) {
            return false;
        }

        activeStroke = next;
        activeX = nextX;
        activeY = nextY;
        return true;
    }

    private boolean finishDrag(
        float xNorm,
        float yNorm
    ) {
        if (!dragActive || activeStroke == null) {
            return false;
        }

        Point size = displaySize();
        float endX =
            clamp(xNorm, 0f, 1f) *
            Math.max(1, size.x - 1);
        float endY =
            clamp(yNorm, 0f, 1f) *
            Math.max(1, size.y - 1);

        Path path = new Path();
        path.moveTo(activeX, activeY);
        path.lineTo(endX, endY);

        GestureDescription.StrokeDescription next =
            activeStroke.continueStroke(
                path,
                0,
                20L,
                false
            );

        boolean accepted = dispatchGesture(
            new GestureDescription.Builder()
                .addStroke(next)
                .build(),
            null,
            null
        );

        activeStroke = null;
        dragActive = false;
        activeX = endX;
        activeY = endY;
        return accepted;
    }

    private AccessibilityNodeInfo focusedInput() {
        AccessibilityNodeInfo root =
            getRootInActiveWindow();

        if (root == null) return null;

        AccessibilityNodeInfo focused =
            root.findFocus(
                AccessibilityNodeInfo.FOCUS_INPUT
            );

        if (
            focused == null ||
            (!focused.isEditable() &&
             !focused.isFocusable())
        ) {
            AccessibilityNodeInfo editable =
                findEditable(root);

            root.recycle();
            return editable;
        }

        root.recycle();
        return focused;
    }

    private boolean replaceSelection(
        String replacement,
        boolean preserveSelection
    ) {
        AccessibilityNodeInfo node =
            focusedInput();

        if (node == null) return false;

        CharSequence currentValue =
            node.getText();

        if (currentValue == null) {
            node.recycle();
            return false;
        }

        String current = currentValue.toString();

        int start =
            Math.max(0, node.getTextSelectionStart());
        int end =
            Math.max(0, node.getTextSelectionEnd());

        if (start > end) {
            int tmp = start;
            start = end;
            end = tmp;
        }

        start = Math.min(start, current.length());
        end = Math.min(end, current.length());

        String nextText =
            current.substring(0, start) +
            replacement +
            current.substring(end);

        Bundle setText = new Bundle();
        setText.putCharSequence(
            AccessibilityNodeInfo
                .ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
            nextText
        );

        boolean result =
            node.performAction(
                AccessibilityNodeInfo.ACTION_SET_TEXT,
                setText
            );

        if (result && !preserveSelection) {
            int caret =
                Math.min(
                    nextText.length(),
                    start + replacement.length()
                );

            Bundle selection =
                new Bundle();

            selection.putInt(
                AccessibilityNodeInfo
                    .ACTION_ARGUMENT_SELECTION_START_INT,
                caret
            );
            selection.putInt(
                AccessibilityNodeInfo
                    .ACTION_ARGUMENT_SELECTION_END_INT,
                caret
            );

            node.performAction(
                AccessibilityNodeInfo
                    .ACTION_SET_SELECTION,
                selection
            );
        }

        node.recycle();
        return result;
    }

    private boolean performKey(
        String code,
        String key,
        boolean ctrl,
        boolean shift
    ) {
        AccessibilityNodeInfo node =
            focusedInput();

        if ("Escape".equals(code)) {
            if (node != null) node.recycle();
            return globalBack();
        }

        if (node == null) return false;

        CharSequence value = node.getText();
        String text =
            value == null ? "" : value.toString();

        int start =
            Math.max(0, node.getTextSelectionStart());
        int end =
            Math.max(0, node.getTextSelectionEnd());

        if (start > end) {
            int tmp = start;
            start = end;
            end = tmp;
        }

        start = Math.min(start, text.length());
        end = Math.min(end, text.length());

        if (alt && "Tab".equals(code)) {
            if (node != null) node.recycle();
            return globalRecents();
        }

        if (meta && "KeyD".equals(code)) {
            if (node != null) node.recycle();
            return globalHome();
        }

        if (ctrl && "KeyA".equals(code)) {
            boolean result = setSelection(
                node,
                0,
                text.length()
            );
            node.recycle();
            return result;
        }

        if (ctrl &&
            ("KeyC".equals(code) ||
             "KeyX".equals(code))) {
            if (start == end) {
                node.recycle();
                return true;
            }

            ClipboardManager clipboard =
                (ClipboardManager)
                    getSystemService(
                        CLIPBOARD_SERVICE
                    );

            clipboard.setPrimaryClip(
                ClipData.newPlainText(
                    "P2P Desk",
                    text.substring(start, end)
                )
            );

            if ("KeyX".equals(code)) {
                return replaceNodeText(
                    node,
                    text.substring(
                        0,
                        start
                    ) + text.substring(end),
                    start
                );
            }

            node.recycle();
            return true;
        }

        if (ctrl && "KeyV".equals(code)) {
            ClipboardManager clipboard =
                (ClipboardManager)
                    getSystemService(
                        CLIPBOARD_SERVICE
                    );

            if (!clipboard.hasPrimaryClip()) {
                node.recycle();
                return false;
            }

            ClipData clip =
                clipboard.getPrimaryClip();

            if (
                clip == null ||
                clip.getItemCount() == 0
            ) {
                node.recycle();
                return false;
            }

            CharSequence pasted =
                clip.getItemAt(0)
                    .coerceToText(this);

            if (pasted == null) {
                node.recycle();
                return false;
            }

            String nextText =
                text.substring(0, start) +
                pasted +
                text.substring(end);

            int caret =
                start + pasted.length();

            return replaceNodeText(
                node,
                nextText,
                caret
            );
        }

        if ("Backspace".equals(code)) {
            int deleteStart =
                start == end
                    ? Math.max(0, start - 1)
                    : start;
            int deleteEnd =
                end;

            if (start == end && start == 0) {
                node.recycle();
                return true;
            }

            return replaceNodeText(
                node,
                text.substring(0, deleteStart) +
                    text.substring(deleteEnd),
                deleteStart
            );
        }

        if ("Delete".equals(code)) {
            int deleteStart = start;
            int deleteEnd =
                start == end
                    ? Math.min(
                        text.length(),
                        end + 1
                    )
                    : end;

            if (deleteStart == text.length()) {
                node.recycle();
                return true;
            }

            return replaceNodeText(
                node,
                text.substring(0, deleteStart) +
                    text.substring(deleteEnd),
                deleteStart
            );
        }

        if ("ArrowLeft".equals(code)) {
            int caret =
                start != end && !shift
                    ? start
                    : Math.max(
                        0,
                        shift ? end - 1 : start - 1
                    );

            boolean result =
                setSelection(
                    node,
                    shift ? start : caret,
                    caret
                );
            node.recycle();
            return result;
        }

        if ("ArrowRight".equals(code)) {
            int caret =
                start != end && !shift
                    ? end
                    : Math.min(
                        text.length(),
                        shift ? end + 1 : end + 1
                    );

            boolean result =
                setSelection(
                    node,
                    shift ? start : caret,
                    caret
                );
            node.recycle();
            return result;
        }

        if ("Home".equals(code)) {
            boolean result =
                setSelection(
                    node,
                    shift ? start : 0,
                    0
                );
            node.recycle();
            return result;
        }

        if ("End".equals(code)) {
            int target = text.length();
            boolean result =
                setSelection(
                    node,
                    shift ? start : target,
                    target
                );
            node.recycle();
            return result;
        }

        if (
            "Enter".equals(code) ||
            "NumpadEnter".equals(code)
        ) {
            if (!node.isEditable() && node.isClickable()) {
                boolean result =
                    node.performAction(
                        AccessibilityNodeInfo.ACTION_CLICK
                    );
                node.recycle();
                return result;
            }

            boolean result = replaceNodeText(
                node,
                text.substring(0, start) +
                    "\n" +
                    text.substring(end),
                start + 1
            );
            return result;
        }

        if ("Space".equals(code) ||
            " ".equals(key)) {
            boolean result = replaceNodeText(
                node,
                text.substring(0, start) +
                    " " +
                    text.substring(end),
                start + 1
            );
            return result;
        }

        if (
            !ctrl &&
            key != null &&
            key.length() == 1
        ) {
            boolean result = replaceNodeText(
                node,
                text.substring(0, start) +
                    key +
                    text.substring(end),
                start + 1
            );
            return result;
        }

        node.recycle();
        return false;
    }

    private boolean replaceNodeText(
        AccessibilityNodeInfo node,
        String nextText,
        int caret
    ) {
        Bundle args = new Bundle();
        args.putCharSequence(
            AccessibilityNodeInfo
                .ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
            nextText
        );

        boolean result =
            node.performAction(
                AccessibilityNodeInfo.ACTION_SET_TEXT,
                args
            );

        if (result) {
            setSelection(
                node,
                caret,
                caret
            );
        }

        node.recycle();
        return result;
    }

    private boolean setSelection(
        AccessibilityNodeInfo node,
        int start,
        int end
    ) {
        Bundle args = new Bundle();

        args.putInt(
            AccessibilityNodeInfo
                .ACTION_ARGUMENT_SELECTION_START_INT,
            Math.max(0, start)
        );
        args.putInt(
            AccessibilityNodeInfo
                .ACTION_ARGUMENT_SELECTION_END_INT,
            Math.max(0, end)
        );

        return node.performAction(
            AccessibilityNodeInfo.ACTION_SET_SELECTION,
            args
        );
    }

    private boolean performSystemAction(
        String action
    ) {
        switch (action) {
            case "back":
                return globalBack();

            case "home":
                return globalHome();

            case "recents":
                return globalRecents();

            case "notifications":
                return performGlobalAction(
                    GLOBAL_ACTION_NOTIFICATIONS
                );

            case "quick_settings":
                return performGlobalAction(
                    GLOBAL_ACTION_QUICK_SETTINGS
                );

            case "power_dialog":
                return performGlobalAction(
                    GLOBAL_ACTION_POWER_DIALOG
                );

            case "lock_screen":
                if (Build.VERSION.SDK_INT >= 28) {
                    return performGlobalAction(
                        GLOBAL_ACTION_LOCK_SCREEN
                    );
                }
                return false;

            case "screenshot":
                if (Build.VERSION.SDK_INT >= 28) {
                    return performGlobalAction(
                        GLOBAL_ACTION_TAKE_SCREENSHOT
                    );
                }
                return false;

            case "split_screen":
                if (Build.VERSION.SDK_INT >= 24) {
                    return performGlobalAction(
                        GLOBAL_ACTION_TOGGLE_SPLIT_SCREEN
                    );
                }
                return false;

            case "media_play_pause":
                if (Build.VERSION.SDK_INT >= 36) {
                    return performGlobalAction(
                        GLOBAL_ACTION_MEDIA_PLAY_PAUSE
                    );
                }
                return false;

            case "menu":
                if (Build.VERSION.SDK_INT >= 36) {
                    return performGlobalAction(
                        GLOBAL_ACTION_MENU
                    );
                }
                return false;

            default:
                return false;
        }
    }

    private AccessibilityNodeInfo findEditable(
        AccessibilityNodeInfo node
    ) {
        if (node == null) return null;
        if (
            node.isEditable() &&
            node.isVisibleToUser()
        ) {
            return node;
        }

        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child =
                node.getChild(i);

            AccessibilityNodeInfo result =
                findEditable(child);

            if (result != null) {
                return result;
            }

            if (child != null) {
                child.recycle();
            }
        }

        return null;
    }

    private static float clamp(
        float value,
        float min,
        float max
    ) {
        return Math.max(
            min,
            Math.min(max, value)
        );
    }
}
