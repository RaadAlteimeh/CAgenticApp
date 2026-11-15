// FFmpeg stage: trims and normalises every clip, builds the dialogue track,
// and mixes in music with automatic ducking under speech.
import fs from "node:fs";
import path from "node:path";
import { ffmpeg, probe, log, ensureDir } from "./util.mjs";

const fmt = (n) => n.toFixed(3);

/** Work out each segment's length and timeline position. */
export async function planTimeline(spec) {
  let t = 0;
  const plan = [];
  for (const [i, s] of spec.segments.entries()) {
    let duration = s.duration;
    let start = 0;
    let info = null;
    if (s.type === "clip") {
      info = await probe(s.src);
      if (!info.hasVideo) throw new Error(`${s.src} has no video stream.`);
      start = s.start ?? 0;
      const end = Math.min(s.end ?? info.duration, info.duration);
      duration = end - start;
      if (duration <= 0.1) throw new Error(`Segment ${i + 1}: start/end leave nothing to show (source is ${info.duration.toFixed(1)}s).`);
    }
    plan.push({ ...s, index: i, at: t, duration, trimStart: start, info });
    t += duration;
  }
  return { segments: plan, total: t };
}

/** Re-encode clips to the project format and produce one continuous dialogue track. */
export async function prepareMedia(spec, timeline, buildDir) {
  const clipsDir = ensureDir(path.join(buildDir, "clips"));
  const audioDir = ensureDir(path.join(buildDir, "audio"));
  const { width: W, height: H, fps } = spec;
  const parts = [];

  for (const seg of timeline.segments) {
    const n = seg.index + 1;
    const wav = path.join(audioDir, `seg${n}.wav`);
    if (seg.type === "clip") {
      log("ffmpeg", `Clip ${n}: ${path.basename(seg.src)} ${fmt(seg.trimStart)}s → ${fmt(seg.trimStart + seg.duration)}s`);
      await ffmpeg([
        "-ss", fmt(seg.trimStart), "-t", fmt(seg.duration), "-i", seg.src,
        "-vf", `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,fps=${fps},format=yuv420p`,
        "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-g", String(fps),
        "-movflags", "+faststart", path.join(clipsDir, `seg${n}.mp4`),
      ]);
      if (seg.info.hasAudio) {
        await ffmpeg([
          "-ss", fmt(seg.trimStart), "-t", fmt(seg.duration), "-i", seg.src,
          "-vn", "-af", `aresample=48000,volume=${seg.volume},apad`, "-t", fmt(seg.duration),
          "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", wav,
        ]);
      } else {
        await silence(seg.duration, wav);
      }
    } else {
      await silence(seg.duration, wav);
    }
    parts.push(wav);
  }

  const list = path.join(audioDir, "concat.txt");
  fs.writeFileSync(list, parts.map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"));
  const voice = path.join(audioDir, "dialogue.wav");
  await ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c:a", "pcm_s16le", voice]);
  return voice;
}

function silence(seconds, out) {
  return ffmpeg(["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", fmt(seconds), "-c:a", "pcm_s16le", out]);
}

// Speech is normalised on its own (≈ -16 LUFS, typical for YouTube/podcasts) BEFORE the music is added,
// so music-only stretches (title cards) stay at the chosen music volume instead of being pumped up.
const VOICE_NORM = "loudnorm=I=-16:TP=-2:LRA=11";
const LIMITER = "alimiter=limit=0.89:level=false";

/** Final soundtrack: normalised dialogue + (optional) looped music, ducked under speech. */
export async function mixSoundtrack({ voice, musicFile, music, total, out }) {
  const T = fmt(total);
  if (!musicFile) {
    log("ffmpeg", "Mixing soundtrack (no music)");
    await ffmpeg(["-i", voice, "-af", `${VOICE_NORM},${LIMITER}`, "-t", T, "-ar", "48000", "-c:a", "pcm_s16le", out]);
    return out;
  }
  log("ffmpeg", `Mixing soundtrack (music at ${Math.round(music.volume * 100)}%${music.duck ? ", ducked under speech" : ""})`);
  const fadeOut = Math.min(2.5, total / 3);
  const musicChain =
    `[1:a]aresample=48000,atrim=0:${T},asetpts=PTS-STARTPTS,volume=${music.volume},` +
    `afade=t=in:d=${fmt(Math.min(1.5, total / 4))},afade=t=out:st=${fmt(total - fadeOut)}:d=${fmt(fadeOut)}[m]`;
  const graph = music.duck
    ? `[0:a]aresample=48000,${VOICE_NORM},aresample=48000,asplit=2[v][sc];${musicChain};` +
      `[m][sc]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=600[md];` +
      `[v][md]amix=inputs=2:duration=first:normalize=0,${LIMITER}[out]`
    : `[0:a]aresample=48000,${VOICE_NORM},aresample=48000[v];${musicChain};[v][m]amix=inputs=2:duration=first:normalize=0,${LIMITER}[out]`;
  await ffmpeg([
    "-i", voice, "-stream_loop", "-1", "-i", musicFile,
    "-filter_complex", graph, "-map", "[out]", "-t", T, "-ar", "48000", "-c:a", "pcm_s16le", out,
  ]);
  return out;
}
