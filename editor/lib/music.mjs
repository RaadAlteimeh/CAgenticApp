// Free music from Openverse (open-source, CC-licensed audio search) — the stand-in for Epidemic Sound.
// API docs: https://api.openverse.org/v1/
import fs from "node:fs";
import path from "node:path";
import { ROOT, log, ensureDir, probe } from "./util.mjs";

const API = "https://api.openverse.org/v1/audio/";
const HEADERS = { "User-Agent": "video-editor-pipeline/1.0 (open-source tooling)" };
const MUSIC_DIR = path.join(ROOT, "assets", "music");

/** Search Openverse for tracks that allow commercial use and modification. */
export async function searchMusic(query, { minSeconds = 0, limit = 10 } = {}) {
  const params = new URLSearchParams({
    q: query,
    license_type: "commercial,modification",
    category: "music",
    page_size: "20",
  });
  const res = await fetch(`${API}?${params}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`Openverse search failed (${res.status}). Try again in a minute — anonymous use is rate-limited.`);
  const data = await res.json();
  return data.results
    .filter((r) => r.url && (r.duration ?? 0) / 1000 >= minSeconds)
    .slice(0, limit)
    .map((r) => ({
      id: r.id,
      title: r.title || "Untitled",
      creator: r.creator || "Unknown artist",
      seconds: Math.round((r.duration ?? 0) / 1000),
      license: `CC ${String(r.license).toUpperCase()} ${r.license_version ?? ""}`.trim(),
      licenseUrl: r.license_url,
      page: r.foreign_landing_url,
      source: r.source,
      url: r.url,
      ext: (r.filetype || path.extname(new URL(r.url).pathname).slice(1) || "mp3").toLowerCase(),
    }));
}

export function creditLine(t) {
  return `"${t.title}" by ${t.creator} — ${t.license} (${t.licenseUrl}) — via Openverse/${t.source}: ${t.page}`;
}

/** Download a track (cached by id) and append its credit to assets/music/CREDITS.txt. */
export async function downloadTrack(track) {
  ensureDir(MUSIC_DIR);
  const file = path.join(MUSIC_DIR, `${track.id}.${track.ext}`);
  if (!fs.existsSync(file)) {
    log("music", `Downloading "${track.title}" by ${track.creator}…`);
    const res = await fetch(track.url, { headers: HEADERS, redirect: "follow" });
    if (!res.ok) throw new Error(`Download failed (${res.status}) for ${track.url}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    const info = await probe(file).catch(() => null);
    if (!info?.hasAudio) {
      fs.rmSync(file, { force: true });
      throw new Error(`"${track.title}" did not download as playable audio.`);
    }
  }
  const credits = path.join(MUSIC_DIR, "CREDITS.txt");
  const line = creditLine(track);
  const existing = fs.existsSync(credits) ? fs.readFileSync(credits, "utf8") : "";
  if (!existing.includes(track.url) && !existing.includes(line)) fs.appendFileSync(credits, line + "\n");
  return file;
}

/** Find + download the first usable track for a query. Returns { file, track }. */
export async function fetchMusicFor(query, minSeconds) {
  let tracks = await searchMusic(query, { minSeconds });
  if (tracks.length === 0) tracks = await searchMusic(query); // accept shorter tracks; they get looped
  if (tracks.length === 0) throw new Error(`No free music found for "${query}". Try a broader search, e.g. "ambient" or "upbeat".`);
  for (const t of tracks) {
    try {
      return { file: await downloadTrack(t), track: t };
    } catch (e) {
      log("music", `Skipping "${t.title}": ${e.message}`);
    }
  }
  throw new Error(`None of the tracks for "${query}" could be downloaded.`);
}
