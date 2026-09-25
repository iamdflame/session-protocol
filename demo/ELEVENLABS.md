# ElevenLabs: voice, music and sound effects for the two SESSION videos

Everything here was checked against ElevenLabs' own documentation on 25 Sep 2026 (sources at the end).

## 1. Pick the voice (5 minutes)

Paste this test line into **Text to Speech** with each candidate, and keep the one that sounds calm, certain, and not like an advert:

```
Monday. Nine thirty, in New York. The Bell oracle posts NVIDIA's opening print... and every order in the cross fills at that one price.
```

Calm, confident male voices to audition (Voice Library → search by name, or filter *Narration*, *Male*, *Middle-aged*):

| Voice | Character | Why try it |
|---|---|---|
| **Daniel** | British, authoritative, a news presenter | Precise and trustworthy; suits "verified on-chain" |
| **George** | British, warm, mature storyteller | The warmest option for Ade's story |
| **Brian** | American, deep, resonant narrator | A documentary feel; strong for the hook and the end card |
| **Adam** | American, deep, steady long-form narrator | The most even pacing across many clips |

If a name isn't in your library, use the filter and pick a *narration* voice with a low, steady delivery. Use **the same voice for both videos.**

## 2. Settings (use the same for every clip)

**Model: Eleven Multilingual v2.** ElevenLabs calls it the most stable for long-form. Every clip then keeps the same timbre, which matters when they are cut together.

| Setting | Pitch video | Technical video | Why |
|---|---|---|---|
| Stability | **55** | **60** | Around 50 is the default; a bit higher keeps a calm narrator steady without going flat |
| Similarity | **75** | **75** | The default; higher can reproduce artefacts |
| Style exaggeration | **0** | **0** | ElevenLabs advises 0: it adds instability |
| Speaker boost | **On** | **On** | Slightly clearer; the latency doesn't matter here |
| Speed | **1.0** | **0.95** | The pitch is tight against 3:00; the technical one has room to breathe |
| Download | **WAV** (or MP3 192 kbps) | same | Lossless into CapCut |

**Optional: Eleven v3** for P01 and P09 only, if you want more drama. Stability **Natural**; no speed control. It honours `...` pauses and CAPITALS for emphasis, and tags like `[whispers]` or `[excited]`. **I don't recommend tags for this voice:** the calm is the point. Mixing models changes the timbre slightly, so if you use v3, check that P01 and P02 still sound like the same person.

## 3. How to generate

1. One generation per scene. Paste the **ElevenLabs** block from `SCRIPT-pitch.md` (P01–P09) or `SCRIPT-technical.md` (T01–T09), not the caption text.
2. Name the downloads `P01.wav` … `P09.wav` and `T01.wav` … `T09.wav`, and put them in `demo/audio/` if you'd like me to re-time the reference cuts to them.
3. If one sentence comes out wrong, regenerate **that scene only**. Keep the version where "print", "bell" and "escrow" land cleanly.
4. The blocks are already written for the voice. Numbers are in words ("one hundred and sixty-eight"), and names are spelled the way they should sound:

| Written | Say it | In the text as |
|---|---|---|
| Pyth | "pith", rhymes with *myth* | `Pith` |
| NYSE | letters | `N-Y-S-E` |
| Ed25519 | "ed twenty-five five-nineteen" | `ed-twenty-five-five-nineteen` |
| LiteSVM | "lite S-V-M" | `Lite-S-V-M` |
| SDK / MCP / AI | letters | `S-D-K`, `M-C-P`, `A.I.` |
| Token-2022 | "token twenty-twenty-two" | `Token twenty-twenty-two` |
| Lagos | "LAY-goss" | as written (all four voices say it well); if not, `Lay-goss` |
| SESSION | "session" | as written |
| devnet | "dev-net" | as written |

5. The `...` marks are deliberate breaths. Keep them.

## 4. Music (Eleven Music)

Both beds are instrumental. Generate at the durations shown; CapCut can trim or loop.

**Pitch bed, 3:00:**
```
Minimal, confident cinematic electronic, 100 BPM, 4/4. Warm analog synth pads, a soft pulsing bass, glassy plucked synth notes, and a very light ticking hi-hat like a clock. Starts sparse and nocturnal for the first 55 seconds, then lifts with a bright rising arpeggio around 0:57 as if a market has just opened, sustains with gentle momentum until 2:40, then resolves on one clean, warm final chord at 2:50 with a short natural tail. Instrumental only, no vocals, no drops, lots of space for a narrator.
```

**Technical bed, 5:00:**
```
Understated, focused electronic ambient for an engineering walkthrough, 90 BPM. Soft sub bass, muted pizzicato synth plucks, slowly evolving pads, very sparse clicky percussion. Steady and unobtrusive, no builds or drops, no melody that competes with speech, loops cleanly. Instrumental only, no vocals.
```

If a generation has a busy lead melody, add *"no lead melody"* and regenerate. Commercial use: Eleven Music is cleared for online commercial use on paid plans.

## 5. Sound effects (Sound Effects generator)

Set the duration by hand; the prompt limit is 450 characters.

| # | Where | Duration | Prompt |
|---|---|---|---|
| S1 | P04 at "Nine thirty"; P09 on the logo | 3.0 s | `A single bright brass bell rung twice, like a stock exchange opening bell, clean and resonant, short natural hall reverb, high quality recording` |
| S2 | Ticket taps, P03 | 0.5 s | `Soft modern user interface tap, subtle and crisp, high quality` |
| S3 | Scene transitions (use sparingly) | 1.0 s | `Smooth airy cinematic whoosh, short and clean, no bass boom` |
| S4 | The signature check passing, P05 and T09 | 1.2 s | `Secure digital lock clicking shut followed by a soft two-note electronic confirmation chime` |
| S5 | The receipt landing, P05 | 1.0 s | `Satisfying document stamp, a low soft thump with a faint paper texture` |
| S6 | Countdown before the bell, P04 | 8.0 s | `Quiet close ticking clock, steady one tick per second, dry studio recording` |
| S7 | Night market texture, P01 and P02, under the music | 10 s | `Very soft distant digital data blips and ticker sounds, calm, sparse, ambient background texture` |
| S8 | Escrow at zero, drills passing, P06 and T06 | 1.0 s | `Gentle positive confirmation tone, two soft rising notes, modern and minimal` |

## 6. Mixing in CapCut

- **Voice.** Select all the voice clips, turn on **Normalize loudness**, and enable **Enhance voice** only if the file sounds thin. Target about −16 LUFS; CapCut's normaliser gets close.
- **Music.** Keep it 18–22 dB below the voice while he speaks: about −20 dB on the music track. Fade in over 1 s, and fade out on the last chord.
- **Sound effects.** S1, the bell, is the only effect meant to stand out, at −6 to −8 dB under peak. Keep the rest at −14 to −20 dB, and use S3 whooshes on no more than 3 transitions per video.
- **Captions.** Run CapCut **Auto captions** on the voice track (English), then fix these spellings: SESSION, Pyth, NVDAx, LiteSVM, Ed25519. `demo/captions/*.srt` is there to compare against.
- **Export.** 1080p, 60 fps, H.264, bitrate *Higher* (about 20–30 Mbps), MP4. Keep the pitch under 3:00 and the technical video under 5:00.

## Sources
- [Eleven v3 prompting (stability modes, audio tags, pauses)](https://elevenlabs.io/docs/best-practices/prompting/eleven-v3)
- [Text to Speech product guide (models, settings, limits, formats)](https://elevenlabs.io/docs/eleven-creative/playground/text-to-speech)
- [Eleven Music overview](https://elevenlabs.io/docs/overview/capabilities/music) · [Sound effects](https://elevenlabs.io/docs/overview/capabilities/sound-effects)
- [ElevenLabs voice library: explainer voice-over](https://elevenlabs.io/voice-library/explainer-voice-over)
