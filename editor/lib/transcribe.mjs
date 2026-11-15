// Speech-to-text with word timings, via HyperFrames' on-device engines (Parakeet, or Whisper if installed).
// Runs fully offline once the model is installed:  npx hyperframes models install parakeet
import fs from "node:fs";
import path from "node:path";
import { ROOT, ffmpeg, hyperframes, ensureDir, log } from "./util.mjs";

const CACHE = path.join(ROOT, "build", "transcripts");
const FILLER = /^(uh+|um+|uhm+|erm+|ah+|hmm+|mm+)$/i;

export const bare = (w) => w.replace(/[^\p{L}\p{N}']+/gu, "").toLowerCase();
export const isFiller = (w) => FILLER.test(bare(w.text));

/** Returns [{ text, start, end }] in source seconds. Cached per file (size + modified time). */
export async function getTranscript(src) {
  const st = fs.statSync(src);
  const key = `${path.basename(src, path.extname(src))}-${st.size}-${Math.round(st.mtimeMs)}`;
  const cached = path.join(ensureDir(CACHE), `${key}.json`);
  if (fs.existsSync(cached)) return JSON.parse(fs.readFileSync(cached, "utf8"));

  log("transcribe", `Transcribing ${path.basename(src)} (on-device)…`);
  const work = ensureDir(path.join(CACHE, `work-${key}`));
  const wav = path.join(work, "audio.wav");
  await ffmpeg(["-i", src, "-vn", "-ac", "1", "-ar", "16000", wav]);
  try {
    await hyperframes(["transcribe", wav, "--dir", work, "--engine", "auto", "--language", "en"], { quiet: true });
  } catch (e) {
    throw new Error(`Transcription failed. Install the free on-device model with:\n  npx hyperframes models install parakeet\n${e.message}`);
  }
  const raw = JSON.parse(fs.readFileSync(path.join(work, "transcript.json"), "utf8"));
  const words = (Array.isArray(raw) ? raw : raw.words ?? [])
    .map((w) => ({ text: String(w.text ?? w.word ?? "").trim(), start: +w.start, end: +w.end }))
    .filter((w) => w.text && Number.isFinite(w.start) && Number.isFinite(w.end));
  fs.writeFileSync(cached, JSON.stringify(words));
  fs.rmSync(work, { recursive: true, force: true });
  log("transcribe", `${words.length} words`);
  return words;
}

/** Apply spelling fixes like { "Sure": "Shure" } while keeping punctuation. */
export function applyFixes(words, fixes = {}) {
  const map = Object.fromEntries(Object.entries(fixes).map(([k, v]) => [bare(k), v]));
  return words.map((w) => {
    const rep = map[bare(w.text)];
    if (!rep) return w;
    const trail = w.text.match(/[^\p{L}\p{N}']+$/u)?.[0] ?? "";
    return { ...w, text: rep + trail };
  });
}

/** Print the transcript as timed sentences — handy for choosing zoom/callout times. */
export function formatTranscript(words) {
  const lines = [];
  let cur = [];
  for (const w of words) {
    cur.push(w);
    if (/[.!?]$/.test(w.text)) { lines.push(cur); cur = []; }
  }
  if (cur.length) lines.push(cur);
  return lines.map((l) => `${l[0].start.toFixed(1).padStart(6)}s  ${l.map((w) => w.text).join(" ")}`).join("\n");
}
