# STT evaluation (B-05)

Date: 2026-10-09. Provider tested: Groq-hosted Whisper through `backend/scripts/stt_eval.py`. Cloudflare Workers AI was **not** tested (no keys).

## Data
Three clips from Adarsh (`backend/scripts/voice_recordings/M01..M03.opus`, 27 to 38 KB, Opus in Ogg). **All three are spoken Malayalam** (confirmed by the team). **No ground-truth transcripts exist yet**, so there is no word error rate and the notes below were not checked by a Malayalam speaker. This is a first signal, not the 10-clip evaluation B-05/D-05 ask for (Malayalam, Hindi, English, with and without noise).

## Ground truth
Adarsh's transcripts are in `backend/scripts/voice_recordings/M01..M03.md` (Malayalam script, clean speech): M01 road accident near Edappally junction, bike and car, two injured, one bleeding heavily, send an ambulance. M02 fire in a building in Kalamassery, smoke from the second floor, people inside, send the fire force, near the old bus stop. M03 a person collapsed near Thripunithura market, not responding, send an ambulance, near the old bus stop. `stt_eval.py` reads these files automatically.

## Word error rate (Groq `whisper-large-v3`, vs ground truth)

| Setting | M01 | M02 | M03 | Mean |
|---|---|---|---|---|
| No prompt (auto or `language=ml`) | 148% | 218% | 162% | 176% (output is English or Latin script, so word match is meaningless) |
| Malayalam prompt (Malayalam script out) | 100% | 100% | 100% | 100% (no word matches the reference) |

Word error rate is useless here: Whisper does not produce correct Malayalam words (Malayalam is agglutinative and Whisper is weak on it). What matters for triage is whether the **facts** survive. Manual check against the ground truth:

| Clip | Facts in the no-prompt output | Lost or wrong |
|---|---|---|
| M01 | accident, Edappally junction, bike and car, two injured, ambulance | heavy bleeding became "serious injury" |
| M02 | fire, Kalamassery (spelled "Kalamashiri"), second floor, person inside, fire force, old bus stop | smoke became "fire coming from" |
| M03 | Thripunithura market (romanised), ambulance, old bus stop, "pettanu"/"prathikarikyunu" (quickly, responding) | collapsed/unresponsive only partly visible in the romanised text |

The no-prompt English/romanised text keeps most facts. The Malayalam-script output (with a prompt) keeps place names but is badly misspelt and drops sentences. `whisper-large-v3-turbo` hallucinated on all three clips (invented place and vehicles, repeated sentences). Speed is fine: 0.5 to 1.5 s.

## Decision (provisional)
- **Groq `whisper-large-v3`, no prompt, is the best available for now** and good enough as a *hint* for triage (intake already tolerates transcription errors, and the category plus audio remain). It is not a faithful Malayalam transcript: do not show it to users as one. Keep the original audio for the admin.
- Turbo is out.
- Cloudflare Workers AI (`cf:` models) uses the same Whisper family, so do not expect a big gain. It is wired up (token in `STT_API_KEY` or `CLOUDFLARE_API_TOKEN`, plus `CLOUDFLARE_ACCOUNT_ID`) but **not tested**: the account ID is missing and the token is scoped to Workers AI only (it cannot list accounts).
- If Malayalam fidelity matters for the demo, test a different engine next: Gemini audio input (Gemini key exists, disclosed provider) or Google Cloud Speech-to-Text `ml-IN`.

## Still to do
1. Adarsh: about 7 more clips (quiet and noisy, some Hindi and English) with the same `.md` ground-truth format.
2. Test Cloudflare (needs the account ID) and one non-Whisper engine (Gemini audio or Google STT) on the same clips.
3. Run each transcript variant through the intake agent and compare incident type and severity.

Reproduce (sends the audio to Groq; only run on team-recorded clips):
```
cd backend
.venv/Scripts/python.exe scripts/stt_eval.py --providers groq:whisper-large-v3,groq:whisper-large-v3-turbo --delay 3
```
