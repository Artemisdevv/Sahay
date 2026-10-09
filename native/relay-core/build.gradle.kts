plugins {
    id("org.jetbrains.kotlin.jvm")
}

kotlin { jvmToolchain(17) }

dependencies {
    // Pure Kotlin on purpose: the protocol is unit-tested on the JVM with no phone.
    api("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")
    // Ed25519 + Base64 that work on every Android version we support (java.util.Base64 and JCA Ed25519 do not).
    implementation("org.bouncycastle:bcprov-jdk18on:1.78.1")
    testImplementation(kotlin("test"))
}

tasks.test {
    useJUnitPlatform()
    testLogging { events("failed"); showStandardStreams = false }
}
