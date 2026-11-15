// FFmpeg stage: plans cuts, trims and normalises every clip, builds the dialogue track,
// and mixes in music with automatic ducking under speech.
import fs from "node:fs";
import path from "node:path";
import { ffmpeg, probe, log, ensureDir } from "./util.mjs";
import { getTranscript, applyFixes, isFiller, bare } from "./transcribe.mjs";

const fmt = (n) => n.toFixed(3);

/**
 * Decide which parts of [start, end] to keep. With `tighten`, filler words ("uh", "um"),
 * stutters ("to to") and pauses longer than maxPause are cut out (jump cuts).
 * Range edges are snapped to the frame grid so audio and video cut at identical times.
 */
function keepRanges(words, start, end, tighten, fps) {
  const snap = (t) => Math.round(t * fps) / fps;
  if (!tighten || words.length === 0) return [[snap(start), snap(end)]];
  const { fillers = true, maxPause = 0.6, pad = 0.15 } = tighten === true ? {} : tighten;

  const inside = words.filter((w) => w.start >= start - 0.05 && w.end <= end + 0.05);
  const drop = new Set();
  inside.forEach((w, i) => {
    if (fillers && isFiller(w)) drop.add(i);
    const next = inside[i + 1];
    if (fillers && next && bare(w.text) === bare(next.text) && next.start - w.end < 0.6 && !/[.!?,]$/.test(w.text)) drop.add(i); // stutter
  });
  const kept = inside.filter((_, i) => !drop.has(i));
  if (kept.length === 0) return [[snap(start), snap(end)]];

  const ranges = [];
  let a = Math.max(start, kept[0].start - 0.35);
  for (let i = 1; i < kept.length; i++) {
    const prev = kept[i - 1];
    const w = kept[i];
    const removed = inside.filter((x, j) => drop.has(j) && x.start >= prev.end - 0.01 && x.end <= w.start + 0.01);
    const gap = w.start - prev.end;
    let cutA, cutB;
    if (removed.length) {
      cutA = Math.max(prev.end + 0.04, Math.min(prev.end + pad, removed[0].start));
      cutB = Math.min(w.start - 0.04, Math.max(w.start - pad, removed.at(-1).end));
    } else if (gap > maxPause) {
      cutA = prev.end + pad;
      cutB = w.start - pad;
    } else continue;
    if (cutB - cutA < 0.08) continue;
    ranges.push([a, cutA]);
    a = cutB;
  }
  ranges.push([a, Math.min(end, kept.at(-1).end + 0.45)]);
  return ranges.map(([x, y]) => [snap(x), snap(y)]).filter(([x, y]) => y - x >= 2 / fps);
}

/** Maps a source time to its time in the edited clip (cut parts collapse to the next kept frame). */
function mapper(ranges) {
  return (t) => {
    let acc = 0;
    for (const [a, b] of ranges) {
      if (t < a) return acc;
      if (t <= b) return acc + (t - a);
      acc += b - a;
    }
    return acc;
  };
}

/** Work out each segment's cuts, length and timeline position. */
export async function planTimeline(spec) {
  let t = 0;
  const plan = [];
  for (const [i, s] of spec.segments.entries()) {
    if (s.type !== "clip") {
      plan.push({ ...s, index: i, at: t });
      t += s.duration;
      continue;
    }
    const info = await probe(s.src);
    if (!info.hasVideo) throw new Error(`${s.src} has no video stream.`);
    const start = s.start ?? 0;
    const end = Math.min(s.end ?? info.duration, info.duration);
    if (end - start <= 0.1) throw new Error(`Segment ${i + 1}: start/end leave nothing to show (source is ${info.duration.toFixed(1)}s).`);

    const needsWords = s.subtitles || s.tighten;
    if (needsWords && !info.hasAudio) throw new Error(`Segment ${i + 1}: subtitles/tighten need audio, but ${path.basename(s.src)} has none.`);
    const words = needsWords ? applyFixes(await getTranscript(s.src), s.fix) : [];

    const ranges = keepRanges(words, start, end, s.tighten, spec.fps);
    const map = mapper(ranges);
    const duration = ranges.reduce((sum, [a, b]) => sum + (b - a), 0);
    const cut = (end - start) - duration;
    if (ranges.length > 1) log("edit", `Clip ${i + 1}: ${ranges.length - 1} jump cuts remove ${cut.toFixed(1)}s of fillers/pauses`);

    const inKept = (x) => ranges.some(([a, b]) => x.start >= a - 0.02 && x.end <= b + 0.08);
    const outWords = s.subtitles
      ? words.filter((w) => !isFiller(w) && inKept(w)).map((w) => ({ text: w.text, start: map(w.start), end: Math.max(map(w.end), map(w.start) + 0.08) }))
      : [];
    const cutsAt = [];
    ranges.slice(0, -1).reduce((acc, [a, b]) => { cutsAt.push(acc + b - a); return acc + b - a; }, 0);

    plan.push({
      ...s,
      index: i,
      at: t,
      duration,
      ranges,
      info,
      words: outWords,
      cutsAt,
      // Author-facing times are recording (source) seconds; convert them to edited-clip seconds.
      zooms: (s.zooms ?? []).map((z) => ({ ...z, at: map(z.at), end: map(z.end ?? z.at + 1.5) })).filter((z) => z.end - z.at > 0.1),
      callouts: (s.callouts ?? []).map((c) => ({ ...c, at: map(c.at), duration: c.duration ?? 2.5 })),
      captions: (s.captions ?? (s.caption ? [{ at: 0, text: s.caption }] : [])).map((c) => ({ ...c, at: map(start + (c.at ?? 0)) })),
    });
    t += duration;
  }
  return { segments: plan, total: t };
}

/** Re-encode clips (with jump cuts) to the project format and produce one continuous dialogue track. */
export async function prepareMedia(spec, timeline, buildDir) {
  const clipsDir = ensureDir(path.join(buildDir, "clips"));
  const audioDir = ensureDir(path.join(buildDir, "audio"));
  const { width: W, height: H, fps } = spec;
  const parts = [];

  for (const seg of timeline.segments) {
    const n = seg.index + 1;
    const wav = path.join(audioDir, `seg${n}.wav`);
    if (seg.type !== "clip") {
      await silence(seg.duration, wav);
      parts.push(wav);
      continue;
    }
    log("ffmpeg", `Clip ${n}: ${path.basename(seg.src)} → ${seg.duration.toFixed(1)}s in ${seg.ranges.length} piece(s)`);

    // Video: one pass. Convert to the project frame rate first, then keep only frames inside the ranges.
    const eps = 0.5 / fps;
    const keep = seg.ranges.map(([a, b]) => `between(t,${fmt(a - eps)},${fmt(b - eps)})`).join("+");
    await ffmpeg([
      "-i", seg.src,
      "-vf", `fps=${fps},select='${keep}',setpts=N/${fps}/TB,` +
        `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p`,
      "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-g", String(fps),
      "-movflags", "+faststart", path.join(clipsDir, `seg${n}.mp4`),
    ]);

    // Audio: each kept piece separately with 10 ms fades so jump cuts don't click.
    if (seg.info.hasAudio) {
      const pieces = [];
      for (const [k, [a, b]] of seg.ranges.entries()) {
        const len = b - a;
        const p = path.join(audioDir, `seg${n}_${k}.wav`);
        await ffmpeg([
          "-ss", fmt(a), "-t", fmt(len), "-i", seg.src, "-vn",
          "-af", `aresample=48000,volume=${seg.volume},afade=t=in:d=0.01,afade=t=out:st=${fmt(Math.max(0, len - 0.012))}:d=0.012,apad`,
          "-t", fmt(len), "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", p,
        ]);
        pieces.push(p);
      }
      await concatWavs(pieces, wav);
      pieces.forEach((p) => fs.rmSync(p, { force: true }));
    } else {
      await silence(seg.duration, wav);
    }
    parts.push(wav);
  }

  const voice = path.join(audioDir, "dialogue.wav");
  await concatWavs(parts, voice);
  return voice;
}

async function concatWavs(files, out) {
  const list = `${out}.txt`;
  fs.writeFileSync(list, files.map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"));
  await ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c:a", "pcm_s16le", out]);
  fs.rmSync(list, { force: true });
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
