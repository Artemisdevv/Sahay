# STT evaluation (B-05)

Date: 2026-10-09. Provider tested: Groq-hosted Whisper through `backend/scripts/stt_eval.py`. Cloudflare Workers AI was **not** tested (no keys).

## Data
Three clips from Adarsh (`backend/scripts/voice_recordings/M01..M03.opus`, 27 to 38 KB, Opus in Ogg). **All three are spoken Malayalam** (confirmed by the team). **No ground-truth transcripts exist yet**, so there is no word error rate and the notes below were not checked by a Malayalam speaker. This is a first signal, not the 10-clip evaluation B-05/D-05 ask for (Malayalam, Hindi, English, with and without noise).

## What each model does with Malayalam speech

| Clip | `whisper-large-v3`, no prompt (auto language, or `language=ml`: same output) | `whisper-large-v3` with a Malayalam prompt | `whisper-large-v3-turbo` |
|---|---|---|---|
| M01 | English: "accident near Edappally Junction, a bike and a car, two injured, send an ambulance" | Malayalam script, spelling rough ("അടപ്പുളൻ ജങ്ഷുണ്" = Edappally junction, "ബയ്കും കാരുണ്" = bike and car, "രണ്ടിപെര്കും" = both/two) | English, wrong details ("Medipoli Junction") |
| M02 | English: "building in Kalamassery caught fire, second floor, a person inside, near the old bus stop" | Malayalam script, shorter ("തീപിടുഷ്ടുണ്ടു" = fire, "കളമ്മശേട്ടിയൽ" = Kalamassery), later sentences missing | Loops one sentence, fire lost |
| M03 | Romanised Malayalam ("Thirupoonithara market ... ambulance ... pazhayu bus stop") | Malayalam script, partly readable, content differs between runs | Loops (auto) or noise characters (`ml`) |

Reading of the table:
- Without a prompt, `large-v3` often returns an **English rendering** of the Malayalam speech (M01, M02) and romanised Malayalam (M03). The English matches the Malayalam-script versions in content (place, bike and car, two people, fire, floor), so it looks like a faithful translation, but nobody has verified this. It is not predictable: the same model gives different scripts per clip.
- With a Malayalam prompt, `large-v3` detects Malayalam and writes Malayalam script, but spelling is poor and parts are dropped.
- `language=ml` alone did nothing on `large-v3`; the **prompt** is what changes the output. On `turbo` it changes the script but the text is noise.
- Speed is not an issue: 0.5 to 1.5 s per clip.

## Decision (provisional)
- **Primary: `groq:whisper-large-v3`.** Turbo hallucinated details on all three clips, which is unacceptable for emergency reports.
- Open question for the intake agent: feed it the English rendering (cleaner, but a silent translation) or the Malayalam script (faithful, but misspelt)? Needs a Malayalam speaker to judge which keeps the facts (place, hazard, people, injuries) better, and an intake run on both. Until then keep the no-prompt default and **always keep the original audio** for the admin reveal path so a human can listen.
- Demo advice: do not depend on Malayalam STT live on stage. Have a typed message ready, and treat STT output as a hint: triage already falls back to the quick-tap category when the text is poor.

## Still to do
1. Adarsh or a Malayalam speaker: for each clip, write what was actually said and mark which output above is closest (add `transcripts.json`: `{"M01.opus": {"language": "ml", "text": "..."}}`), then record about 10 clips (quiet and noisy, some Hindi and English).
2. Rerun `scripts/stt_eval.py` for word error rates. Add a `--prompt` option and a per-language prompt in the adapter if prompting wins. Test Cloudflare `cf:` models if a key is available.
3. Run each transcript variant through the intake agent and compare incident type and severity.

Reproduce (sends the audio to Groq; only run on team-recorded clips):
```
cd backend
.venv/Scripts/python.exe scripts/stt_eval.py --providers groq:whisper-large-v3,groq:whisper-large-v3-turbo --delay 3
```
