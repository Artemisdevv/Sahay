"""Run the voice clips through the configured STT providers and print transcripts, latency and word error rate.

Usage (from backend/):
  .venv/Scripts/python.exe scripts/stt_eval.py [--providers groq:whisper-large-v3-turbo,groq:whisper-large-v3]
                                              [--dir scripts/voice_recordings] [--lang ml] [--delay 2]

This SENDS THE AUDIO to the providers. Only run it on clips the team recorded for this purpose.
Ground truth (optional): scripts/voice_recordings/transcripts.json = {"M01.opus": {"language": "ml", "text": "..."}}.
Without it the script only prints transcripts for a human to judge. Results go to stdout; paste them into docs/stt-eval.md.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.agents.stt_live import STTError, build_live  # noqa: E402
from app.settings import settings  # noqa: E402

MIME = {".opus": "audio/ogg", ".ogg": "audio/ogg", ".webm": "audio/webm", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4"}


def words(text: str) -> list[str]:
    cleaned = "".join(ch if unicodedata.category(ch)[0] in "LMN" or ch.isspace() else " " for ch in text.lower())
    return cleaned.split()


def wer(ref: str, hyp: str) -> float:
    r, h = words(ref), words(hyp)
    if not r:
        return 0.0 if not h else 1.0
    prev = list(range(len(h) + 1))
    for i, rw in enumerate(r, 1):
        cur = [i]
        for j, hw in enumerate(h, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (rw != hw)))
        prev = cur
    return prev[-1] / len(r)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--providers", default=settings.sahay_stt_providers)
    ap.add_argument("--dir", default=str(Path(__file__).with_name("voice_recordings")))
    ap.add_argument("--lang", default="", help="language hint for every clip (default: from transcripts.json, else auto)")
    ap.add_argument("--delay", type=float, default=2.0, help="seconds between calls (free-tier rate limits)")
    args = ap.parse_args()

    groq_key = settings.stt_api_key or (settings.llm_api_key if settings.llm_provider.lower() == "groq" else "")
    folder = Path(args.dir)
    truth_file = folder / "transcripts.json"
    truth = json.loads(truth_file.read_text(encoding="utf-8")) if truth_file.exists() else {}
    clips = sorted(p for p in folder.iterdir() if p.suffix.lower() in MIME)
    if not clips:
        print(f"no audio clips in {folder}")
        return 1

    for name in (x.strip() for x in args.providers.split(",") if x.strip()):
        try:
            provider = build_live(name, groq_key, settings.cloudflare_account_id, settings.cloudflare_api_token, settings.sahay_stt_timeout_s).providers[0]
        except RuntimeError as exc:
            print(f"== {name}: skipped ({exc})")
            continue
        print(f"== {name}")
        total, scored = 0.0, 0
        for clip in clips:
            meta = truth.get(clip.name, {})
            lang = args.lang or meta.get("language", "")
            started = time.perf_counter()
            try:
                text = provider.transcribe(clip.read_bytes(), MIME[clip.suffix.lower()], lang) or ""
                err = ""
            except STTError as exc:
                text, err = "", str(exc)
            secs = time.perf_counter() - started
            line = f"{clip.name} ({len(clip.read_bytes()) // 1024} KB, lang={lang or 'auto'}, {secs:.1f}s): "
            if err:
                print(line + f"FAILED {err}")
            else:
                score = ""
                if meta.get("text"):
                    w = wer(meta["text"], text)
                    total, scored = total + w, scored + 1
                    score = f"  WER {w:.0%}"
                print(line + repr(text) + score)
            time.sleep(args.delay)
        if scored:
            print(f"-- mean WER {total / scored:.0%} over {scored} clips")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
