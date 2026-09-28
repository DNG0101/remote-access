# P2P Desk Android host

This native Android app is the **host** when the controlling device is a PC browser.

## PC → Android flow

1. Build and install the Android app.
2. Open the app on the phone.
3. Enter a six-digit session code.
4. Enable **Allow PC to control this phone**.
5. Open Android Accessibility settings and enable the P2P Desk accessibility service.
6. Tap **Start Android host** and approve Android's screen-capture dialog.
7. On the PC, open the web client and choose **Controller**.
8. Enter the same code and join.
9. Use **Request control** from the PC.
10. Use the PC pointer on the phone screen: left click is a tap, right click is a long press, and the wheel scrolls.
11. The PC mobile keyboard sends text to the currently focused editable Android view.

The Android side uses MediaProjection for screen capture and AccessibilityService gesture APIs for user-authorized remote touch/navigation. Modern Android requires the media-projection foreground-service type and the corresponding permission, and the screen capture consent must happen before the service starts projection. 

## Build

Open the android directory in Android Studio, or use:

gradle -p android :app:assembleDebug

The project uses Android Gradle Plugin 9.4.x and the WebRTC Android SDK artifact published as io.github.webrtc-sdk:android.

## Important permissions

The phone owner must explicitly enable both:
- Android screen capture for the session.
- P2P Desk AccessibilityService for remote input.

Android intentionally blocks browser-only apps from performing these native operations. 
