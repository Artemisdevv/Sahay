plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "sahay.relay.android"
    compileSdk = 34

    defaultConfig { minSdk = 23 }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    api(project(":relay-core"))
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("com.google.android.gms:play-services-nearby:19.3.0")
}
