// Service Worker registration for PWA. Skipped inside the Android app: the APK already ships the assets.
import { Capacitor } from "@capacitor/core";

export function registerSW() {
  if (Capacitor.isNativePlatform()) return;
  if ("serviceWorker" in navigator) {
    const register = () => {
      navigator.serviceWorker
        .register("/sw.js")
        .then((registration) => {
          console.log("[SW] Registered:", registration.scope);
          registration.addEventListener("updatefound", () => {
            const newWorker = registration.installing;
            if (newWorker) {
              newWorker.addEventListener("statechange", () => {
                if (
                  newWorker.state === "installed" &&
                  navigator.serviceWorker.controller
                ) {
                  console.log("[SW] New version available");
                  // Optionally notify user to refresh
                }
              });
            }
          });
        })
        .catch((error) => {
          console.warn("[SW] Registration failed:", error);
        });
    };

    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register, { once: true });
    }
  }
}

export function unregisterSW() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.ready.then((registration) => {
      registration.unregister();
    });
  }
}
