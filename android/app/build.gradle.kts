// No AndroidX: platform APIs only.
plugins {
    id("com.android.application")
}

android {
    namespace = "com.dashpad"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.dashpad"
        minSdk = 31
        targetSdk = 36
        versionCode = 3
        versionName = "0.3.0"
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = true
    }
}
