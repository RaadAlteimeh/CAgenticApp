# CAgenticApp — Video Editing System

A free, open-source video pipeline. You describe a video in a small JSON file, and one command records, cuts, scores, titles, captions and renders it to MP4.

| Stage | Tool | Why |
|---|---|---|
| Record screen / webcam | **[OBS Studio](https://obsproject.com)** | Free, open-source replacement for Tella (paid) |
| Trim, resize, clean audio, mix | **[FFmpeg](https://ffmpeg.org)** | Free, open source |
| Background music | **[Openverse](https://openverse.org)** | Free, open-source library of Creative Commons music; replaces Epidemic Sound (paid) |
| Titles, captions, transitions, final render | **[HyperFrames](https://hyperframes.heygen.com)** | Free, open source (Apache 2.0): HTML + GSAP → MP4 |

## Requirements

Node.js 22+, FFmpeg, OBS Studio and Google Chrome. On Windows:

```bash
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Gyan.FFmpeg -e
winget install --id OBSProject.OBSStudio -e
npm install
npm run doctor
```

## Quick start

```bash
npm run sample                      # makes two demo clips in samples/
npm run make -- edits/example.json  # renders output/example.mp4
```

## Making your own video

1. **Record.** `npm run record` opens OBS (`npm run record -- --start` starts recording right away). Set OBS → Settings → Output → Recording Path to this project's `recordings/` folder. Any `.mp4`/`.mkv`/`.mov` works.
2. **Describe the edit.** `npm run new -- my-video` creates `edits/my-video.json`:

   ```json
   {
     "title": "My video",
     "output": "output/my-video.mp4",
     "music": { "query": "calm ambient", "volume": 0.25, "duck": true },
     "segments": [
       { "type": "title", "text": "My video", "subtitle": "A short subtitle", "duration": 3 },
       { "type": "clip", "src": "recordings/take1.mp4", "start": 4.5, "end": 62, "caption": "Setting things up" },
       { "type": "clip", "src": "recordings/take2.mp4",
         "captions": [ { "at": 0, "duration": 5, "text": "First point" }, { "at": 6, "text": "Second point" } ] },
       { "type": "title", "text": "Thanks for watching", "duration": 2.5 }
     ]
   }
   ```

3. **Preview** (optional): `npm run preview -- edits/my-video.json` opens HyperFrames' live preview in your browser.
4. **Render**: `npm run make -- edits/my-video.json` writes the MP4 to `output/`.

### Edit file reference

| Field | Default | Meaning |
|---|---|---|
| `width`, `height`, `fps` | 1920, 1080, 30 | Output size. Use 1080×1920 for Shorts/Reels/TikTok. |
| `quality` | `standard` | HyperFrames quality: `draft`, `standard`, `looks`, `delivery`. |
| `theme` | dark/blue | `background`, `accent`, `text`, `font`. |
| `transition` | 0.4 | Fade length in seconds between segments. |
| `music.query` | — | Openverse search; picks a track allowed for commercial use and editing, and loops it if it's short. |
| `music.file` | — | Use your own audio file instead. |
| `music.volume` | 0.25 | Music level relative to speech. |
| `music.duck` | true | Lower the music automatically while someone is speaking. |
| clip `start` / `end` | whole clip | Trim points in seconds. |
| clip `volume` | 1 | Gain on the clip's own audio. |
| clip `caption` / `captions` | — | One caption for the whole clip, or a timed list (`at` and `duration` are relative to the clip). |

## Music licensing

Openverse tracks are Creative Commons. Most require **attribution**, and some (BY-SA) require the same license for derivatives. Every track the tool downloads is credited in `assets/music/CREDITS.txt`; paste those lines into your video description. Browse first with `npm run music -- lofi chill`, then download a pick with `npm run music -- lofi chill --get 3`.

## How it works

```
recordings/*.mp4 ──FFmpeg──▶ build/<name>/clips/*.mp4      (trimmed, scaled, 30 fps, silent)
                 └─FFmpeg──▶ build/<name>/audio/dialogue.wav (clip audio, silence under titles)
Openverse ───────download─▶ assets/music/<id>.mp3 ──FFmpeg (loudness + ducking)──▶ soundtrack.wav
edit JSON ─────compose────▶ build/<name>/index.html          (HyperFrames composition + GSAP)
                                   └──HyperFrames lint + render──▶ output/<name>.mp4
```

Code lives in `editor/`: `cli.mjs` (commands), `lib/prep.mjs` (FFmpeg), `lib/music.mjs` (Openverse), `lib/compose.mjs` (HyperFrames HTML), `lib/record.mjs` (OBS).
