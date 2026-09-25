# The SESSION demo videos: assembly guide (CapCut)

Two videos for the Stocklana submission:

- **Pitch**: under 3:00. Clips `P01`–`P09`, target about 2:50.
- **Technical**: under 5:00. Clips `T01`–`T09`, target about 4:40.

## What's here

| Path | What |
|---|---|
| `SCRIPT-pitch.md`, `SCRIPT-technical.md` | Each scene's voiceover, what's on screen, and where every figure comes from |
| `ELEVENLABS.md` | The voice, its settings, the music and sound-effect prompts, and the mixing targets |
| `out/pitch/P01-….mp4` … `P09-….mp4` | The pitch, one silent 1080p30 H.264 clip per scene |
| `out/technical/T01-….mp4` … `T09-….mp4` | The technical video, likewise |
| `out/pitch-reference.mp4`, `out/technical-reference.mp4` | The clips joined, with the script burned in as captions: a timing guide, not the final |
| `captions/pitch.srt`, `captions/technical.srt` | The script as captions, timed to the clips |
| `captures/` | The raw recordings and 4K stills of the live site, in case you want a different cut |
| `broll/` | The stock footage (Mixkit, Free License; see `broll/LICENSES.md`) |

The clips are silent on purpose: the voice, music and sound effects are yours from ElevenLabs.

## Assembling in CapCut

1. **New project**, 1920×1080, 30 fps.
2. **Import** `out/pitch/` (or `out/technical/`) and your ElevenLabs files (`P01.wav` …).
3. **Main track:** drop the clips in number order. **Voice track:** drop each `Pnn.wav` at the start of its clip.
4. **Trim each clip to its voice.** Every clip runs about half a second past its line on purpose. Trim the end of the clip, not the start: each scene builds in during its first second.
   - If a line runs *longer* than its clip, slow the clip slightly (Speed 0.9×), or hold its last frame (*Freeze*) for the difference.
   - Scene timings inside a clip follow the script's sentence order, so if the voice is much faster or slower, check where each figure appears against the line that names it.
5. **Transitions:** the clips already fade in and out of the dark ground, so hard cuts between them look right. Add a *Cross dissolve* (0.3 s) only between P01→P02 and P08→P09 if you want.
6. **Music:** one bed per video, from `ELEVENLABS.md` §4, on its own track, at −20 dB under the voice. Fade in over 1 s, and end on the final chord at the end card.
7. **Sound effects** (`ELEVENLABS.md` §5):
   - **S1, the bell:** in P04, on the clock reaching 09:30:00, about 6 s in. In P09, on the logo.
   - **S2, the tap:** in P03, on the click of "Place buy order".
   - **S4, the lock:** in P05 as the signature checks appear.
   - **S8, the confirm:** in P06 as each drill's last line ticks.
   - **S6, the ticking:** under the P04 countdown, 0–6 s.
   - Keep the rest sparse.
8. **Captions:** *Auto captions* on the voice track, then fix these names: SESSION, Pyth, NVDAx, LiteSVM, Ed25519. Or import `captions/*.srt` and nudge it to your voice.
9. **Loudness:** select the voice clips, then *Normalize loudness*. The music sits about 18–22 dB below the voice.
10. **Export:** 1080p, 30 fps (or 60 if you prefer; the clips are 30), H.264 MP4, bitrate *Higher*. Check the length: the pitch must stay under 3:00 and the technical video under 5:00.

## Scene notes

- **P03:** Ade's order is a real order placed through the live site at the 25 Sep open. The toast and "Your orders" are what the page showed.
- **P04–P06, T06, T07:** these are from today's real bell: the print, the cleared cross, its receipt, and the issuer drills. The numbers on screen came from the chain (`demo/capture/live.mjs`), never typed in.
- **Honesty labels:** the DEVNET and SIMULATED chips stay in every devnet shot. The prints on devnet come from a test signer and say so. Please don't crop them out.

## Re-rendering

This machine renders frame by frame, because it takes over a second per screenshot:

```bash
cd demo/video
node_modules/.bin/esbuild player/entry.tsx --bundle --outfile=player/dist/player.js --format=esm --jsx=automatic --loader:.json=json "--define:process.env.NODE_ENV=\"production\"" --minify
node player/frames.mjs P04 P05 --tabs 4     # or: pitch | technical
```

On a faster machine, `npx remotion render src/index.ts <Scene> out.mp4` works directly, and `npx remotion studio src/index.ts` previews every scene.
