plugins {
    id("com.android.application")
}

android {
    namespace = "com.p2pdesk.android"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.p2pdesk.android"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"
    }

    buildTypes {
        release {
            minifyEnabled = false
        }
    }
}

dependencies {
    implementation("io.github.webrtc-sdk:android:150.7871.01")
    implementation("org.java-websocket:Java-WebSocket:1.6.0")
    testImplementation("junit:junit:4.13.2")
}
