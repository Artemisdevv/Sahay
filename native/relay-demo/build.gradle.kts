plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "sahay.relay.demo"
    compileSdk = 34

    defaultConfig {
        applicationId = "in.sahay.relaydemo"
        minSdk = 23
        targetSdk = 34
        versionCode = 1
        versionName = "0.1"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation(project(":relay-android"))
    implementation("androidx.appcompat:appcompat:1.7.0")
}
