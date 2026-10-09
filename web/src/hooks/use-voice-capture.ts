import { useCallback, useEffect, useRef, useState } from "react";

export type VoiceState =
  "idle" | "recording" | "ready" | "denied" | "unsupported";

export type VoiceClip = {
  blob: Blob;
  url: string;
  seconds: number;
  mimeType: string;
};

const MAX_SECONDS = 60;

function canRecord(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof MediaRecorder !== "undefined"
  );
}

/**
 * Hold-to-talk recording for the report button (browser MediaRecorder, same code in the Android WebView).
 * Noise handling is limited to getUserMedia constraints; we never promise to isolate one speaker.
 * This hook only captures audio. Signing, encryption, queueing and sending belong to the report pipeline (F-03).
 */
export function useVoiceCapture() {
  // Always "idle" on the first render so server and browser HTML match; support is checked after mount.
  const [state, setState] = useState<VoiceState>("idle");
  useEffect(() => {
    if (!canRecord()) setState("unsupported");
  }, []);
  const [seconds, setSeconds] = useState(0);
  const [clip, setClip] = useState<VoiceClip | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<number | null>(null);
  const startedAt = useRef(0);
  const wantStop = useRef(false);

  const cleanup = useCallback(() => {
    if (timer.current) window.clearInterval(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  }, []);

  useEffect(
    () => () => {
      cleanup();
      if (clip) URL.revokeObjectURL(clip.url);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const stop = useCallback(() => {
    wantStop.current = true;
    if (recorder.current && recorder.current.state === "recording")
      recorder.current.stop();
  }, []);

  const start = useCallback(async () => {
    if (state === "recording" || state === "unsupported") return;
    wantStop.current = false;
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      stream.current = media;
      if (wantStop.current) {
        // Finger lifted before the microphone was ready.
        cleanup();
        return;
      }
      chunks.current = [];
      // 16 kbps Opus keeps 60 s near 120 KB, under the 200 KB cap in the report contract.
      const preferred = "audio/webm;codecs=opus";
      const rec = new MediaRecorder(media, {
        audioBitsPerSecond: 16_000,
        ...(MediaRecorder.isTypeSupported(preferred)
          ? { mimeType: preferred }
          : {}),
      });
      recorder.current = rec;
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.current.push(e.data);
      };
      rec.onstop = () => {
        const elapsed = Math.max(
          1,
          Math.round((Date.now() - startedAt.current) / 1000),
        );
        cleanup();
        if (!chunks.current.length || elapsed < 1) {
          setState("idle");
          return;
        }
        const blob = new Blob(chunks.current, {
          type: rec.mimeType || "audio/webm",
        });
        setClip((old) => {
          if (old) URL.revokeObjectURL(old.url);
          return {
            blob,
            url: URL.createObjectURL(blob),
            seconds: elapsed,
            mimeType: blob.type,
          };
        });
        setState("ready");
      };
      startedAt.current = Date.now();
      setSeconds(0);
      setState("recording");
      rec.start();
      timer.current = window.setInterval(() => {
        const s = Math.round((Date.now() - startedAt.current) / 1000);
        setSeconds(s);
        if (s >= MAX_SECONDS) stop();
      }, 250);
    } catch {
      cleanup();
      setState("denied");
    }
  }, [cleanup, state, stop]);

  const reset = useCallback(() => {
    setClip((old) => {
      if (old) URL.revokeObjectURL(old.url);
      return null;
    });
    setSeconds(0);
    setState(canRecord() ? "idle" : "unsupported");
  }, []);

  return { state, seconds, clip, start, stop, reset, maxSeconds: MAX_SECONDS };
}
