# STT evaluation (B-05)

Date: 2026-10-09. Providers tested: Groq-hosted Whisper and Gemini audio through `backend/scripts/stt_eval.py`. Cloudflare Workers AI was **not** tested yet (account ID missing).

## Data
Three clips from Adarsh (`backend/scripts/voice_recordings/M01..M03.opus`, 27 to 38 KB, Opus in Ogg). **All three are spoken Malayalam**, clean speech, with ground-truth transcripts from Adarsh. Three clips are a first signal, not the 10-clip evaluation B-05/D-05 ask for (Malayalam, Hindi, English, with and without noise).

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

## Gemini audio (same clips, `temperature 0`, transcribe-only prompt)

| Model | M01 | M02 | M03 | Mean WER | Time per clip |
|---|---|---|---|---|---|
| `gemini-2.5-flash` | 26% | 64% | 57% | **49%** | 4 s |
| `gemini-2.5-pro` | 26% | 73% | 57% | 52% | 8 s |
| `gemini-flash-latest` | 35% | 73% | 52% | 53% | 5 to 29 s |

Output is faithful **Malayalam script** and every key fact survives: Edappally junction, bike and car collided, two injured, heavy bleeding (ചോര), Kalamassery, smoke (പുക) from the second floor, people inside, fire force, Thripunithura market, collapsed (കുഴഞ്ഞു വീണു) and not responding, ambulance, old bus stop. The remaining word error is mostly the reference text being cleaner than the callers' spoken style (extra "ഇങ്ങോട്ട്", "ട്ടോ", different verb forms), not lost information. Compared with Whisper (100%+ and facts partly lost) this is the clear winner.

Caveats: results come from 3 clips (clean speech); Gemini's documented formats are WAV, MP3, AIFF, AAC, OGG, FLAC, and the browser recorder produces **WebM/Opus**, which was not tested (no ffmpeg here to make a sample). The provider chain therefore falls back to Whisper if Gemini rejects a clip. Free-tier Gemini keys may let Google use the audio to improve its products: use a paid key for real reports. Latency is higher (4 s) than Whisper (1 s), fine because transcription runs server-side after the report is received.

## Decision
- **Primary STT: `gemini:gemini-2.5-flash`, fallback `groq:whisper-large-v3`** (default `SAHAY_STT_PROVIDERS`). Whisper is only a safety net: it is not a faithful Malayalam transcript (facts partly survive, as an English or romanised hint).
- Whisper turbo is out (hallucinations on all three clips).
- Cloudflare Workers AI `cf:` is wired but untested (account ID missing); same Whisper family, so not expected to beat Gemini.
- Keep the original audio for the admin reveal path.

## Still to do
1. Adarsh: about 7 more clips (quiet and noisy, some Hindi and English) with the same `.md` ground-truth format.
2. Verify Gemini with a real browser WebM/Opus recording and with noisy clips; test Cloudflare (needs the account ID); consider Google Cloud Speech-to-Text `ml-IN` if Gemini free-tier data terms are a problem.
3. Run each transcript variant through the intake agent and compare incident type and severity.

Reproduce (sends the audio to the providers; only run on team-recorded clips):
```
cd backend
.venv/Scripts/python.exe scripts/stt_eval.py --providers gemini:gemini-2.5-flash,groq:whisper-large-v3 --delay 3
```
