import { Capacitor, WebPlugin, registerPlugin } from "@capacitor/core";

/**
 * Secrets storage for the device signing seed and bearer token.
 *
 * Android app: AES-256-GCM with a key held in the Android Keystore (plugin `SahaySecureStore`).
 * Browser/PWA: there is no Keystore, so this falls back to localStorage. That is readable by any script on the
 * page, so `hardwareBacked` is false and callers must not treat it as secure. Use it for development only.
 */
export interface SecureStorageInfo {
  /** true on the Android app. false means plain browser storage. */
  native: boolean;
  /** true when the Keystore key is inside a TEE or StrongBox. */
  hardwareBacked: boolean;
}

interface SahaySecureStorePlugin {
  set(opts: { key: string; value: string }): Promise<void>;
  get(opts: { key: string }): Promise<{ value: string | null }>;
  remove(opts: { key: string }): Promise<void>;
  clear(): Promise<void>;
  info(): Promise<SecureStorageInfo>;
}

const PREFIX = "sahay.secure.";

class SahaySecureStoreWeb extends WebPlugin implements SahaySecureStorePlugin {
  async set({ key, value }: { key: string; value: string }) {
    window.localStorage.setItem(PREFIX + key, value);
  }
  async get({ key }: { key: string }) {
    return { value: window.localStorage.getItem(PREFIX + key) };
  }
  async remove({ key }: { key: string }) {
    window.localStorage.removeItem(PREFIX + key);
  }
  async clear() {
    Object.keys(window.localStorage)
      .filter((k) => k.startsWith(PREFIX))
      .forEach((k) => window.localStorage.removeItem(k));
  }
  async info(): Promise<SecureStorageInfo> {
    return { native: false, hardwareBacked: false };
  }
}

const plugin = registerPlugin<SahaySecureStorePlugin>("SahaySecureStore", {
  web: () => new SahaySecureStoreWeb(),
});

/** The shape the rest of the app depends on, so tests can pass an in-memory implementation. */
export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export const secureStorage: SecretStore & { info(): Promise<SecureStorageInfo>; isNative: boolean } = {
  get: async (key) => (await plugin.get({ key })).value ?? null, // native omits the key when nothing is stored
  set: (key, value) => plugin.set({ key, value }),
  remove: (key) => plugin.remove({ key }),
  info: () => plugin.info(),
  isNative: Capacitor.isNativePlatform(),
};
