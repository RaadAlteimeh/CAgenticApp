// Loads and validates an edit spec (the JSON file that describes one video).
import fs from "node:fs";
import path from "node:path";
import { ROOT, fail } from "./util.mjs";

const DEFAULTS = {
  title: "Untitled video",
  output: "output/video.mp4",
  width: 1920,
  height: 1080,
  fps: 30,
  quality: "standard",
  theme: { background: "#0b0d12", accent: "#5b8cff", text: "#ffffff", font: "Segoe UI, Inter, Arial, sans-serif" },
  transition: 0.4,
  music: null,
};

export function loadSpec(file) {
  const full = path.resolve(ROOT, file);
  if (!fs.existsSync(full)) fail(`Edit file not found: ${file}`);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(full, "utf8"));
  } catch (e) {
    fail(`${file} is not valid JSON: ${e.message}`);
  }
  const spec = { ...DEFAULTS, ...raw, theme: { ...DEFAULTS.theme, ...(raw.theme ?? {}) } };
  spec.name = path.basename(full, path.extname(full));
  spec.file = full;

  if (!Array.isArray(spec.segments) || spec.segments.length === 0) fail(`${file}: "segments" must be a non-empty list.`);
  spec.segments = spec.segments.map((s, i) => {
    const where = `${file} segment ${i + 1}`;
    if (s.type === "title") {
      if (!s.text) fail(`${where}: a title needs "text".`);
      return { duration: 3, ...s };
    }
    if (s.type === "clip") {
      if (!s.src) fail(`${where}: a clip needs "src".`);
      const src = path.resolve(ROOT, s.src);
      if (!fs.existsSync(src)) fail(`${where}: video not found: ${s.src}`);
      if (s.end != null && s.start != null && s.end <= s.start) fail(`${where}: "end" must be after "start".`);
      return { volume: 1, ...s, src };
    }
    fail(`${where}: "type" must be "title" or "clip".`);
  });

  if (spec.music && !spec.music.query && !spec.music.file) fail(`${file}: "music" needs a "query" (search Openverse) or a "file".`);
  if (spec.music) spec.music = { volume: 0.25, duck: true, ...spec.music };
  return spec;
}
