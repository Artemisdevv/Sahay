# STT evaluation (B-05)

Date: 2026-10-09. Provider tested: Groq-hosted Whisper through `backend/scripts/stt_eval.py`. Cloudflare Workers AI was **not** tested (no keys).

## Data
Three clips from Adarsh (`backend/scripts/voice_recordings/M01..M03.opus`, 27 to 38 KB, Opus in Ogg). **No ground-truth transcripts exist yet**, so there is no word error rate: results below are judged by reading. Treat this as a first signal, not the 10-clip evaluation D-05/B-05 ask for (needs Malayalam, Hindi, English, with and without noise, plus transcripts in `transcripts.json`).

What the clips say (from the better model, checked by ear by whoever recorded them: please confirm):
- M01: English, road accident near Edappally Junction, bike and car, two injured, asks for an ambulance.
- M02: English, building fire at Kalamassery, second floor, a person inside, near the old bus stop.
- M03: spoken Malayalam mixed with English words (ambulance, bus stop, market).

## Results (language auto-detected unless noted; every call took 0.5 to 1.5 s)

| Clip | whisper-large-v3 | whisper-large-v3-turbo |
|---|---|---|
| M01 | Correct and complete: accident, Edappally, bike and car, two injured, ambulance | Wrong: "Medipoli Junction", invents cars and ambulances |
| M02 | Correct: fire, Kalamassery (spelled "Kalamashiri"), second floor, person inside, old bus stop | Loops "I was in the city of Kalamashiri", fire lost |
| M03 | Malayalam written in Latin letters; place and meaning partly recoverable ("market", "ambulance", "pazhayu bus stop") | Auto: loops and invents text. With `language=ml`: Malayalam script, but unreadable noise |

`language=ml` made no difference for large-v3 on M03 (same output as auto).

## Decision
- **Primary: `groq:whisper-large-v3`.** Turbo is not acceptable for emergency reports: it hallucinated details on all three clips. Default in `SAHAY_STT_PROVIDERS` is now `groq:whisper-large-v3`.
- Malayalam is the weak spot, as expected: output is romanised and noisy. The agent pipeline already falls back to the quick-tap category when text is poor, and the intake prompt tells the model to expect transcription errors. Keep the original audio for the admin (reveal path) so a human can listen.
- Do not rely on STT for the stage demo of Malayalam: use the English clips (M01, M02) or a typed message, and keep the 20 s relay clip as a separate fallback.

## Still to do
1. Adarsh: record about 10 clips (ml, hi, en, quiet and noisy) and add `transcripts.json` (`{"M01.opus": {"language": "en", "text": "..."}}`).
2. Rerun `scripts/stt_eval.py` for word error rates; add Cloudflare `cf:` models if a key is available; try `whisper-large-v3` with a Malayalam prompt.
3. Run the M03 transcript through the intake agent to see whether the romanised text still gives the right incident type and severity.

Reproduce (sends the audio to Groq, run only on team-recorded clips):
```
cd backend
.venv/Scripts/python.exe scripts/stt_eval.py --providers groq:whisper-large-v3,groq:whisper-large-v3-turbo --delay 3
```
