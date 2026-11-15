#!/usr/bin/env node
// Video editing pipeline: OBS (record) → FFmpeg (cut/clean/mix) → Openverse (music) → HyperFrames (titles, captions, render).
import fs from "node:fs";
import path from "node:path";
import { ROOT, log, fail, ensureDir, ffmpeg, hyperframes, rel, run } from "./lib/util.mjs";
import { loadSpec } from "./lib/spec.mjs";
import { planTimeline, prepareMedia, mixSoundtrack } from "./lib/prep.mjs";
import { writeComposition } from "./lib/compose.mjs";
import { searchMusic, downloadTrack, fetchMusicFor, creditLine } from "./lib/music.mjs";
import { launchObs } from "./lib/record.mjs";

const HELP = `
Video editor — commands (run with: npm run <command> -- <args>)

  make <edit.json>        Build and render a video described by an edit file
  preview <edit.json>     Build it, then open the HyperFrames live preview in your browser
  new <name>              Create edits/<name>.json from the template
  music <search words>    Search free music on Openverse  (add --get N to download result N)
  record [--start]        Open OBS Studio (with --start it begins recording immediately)
  sample                  Generate two demo clips in samples/ so you can try the pipeline
  doctor                  Check that FFmpeg, Node and HyperFrames are ready
`;

async function build(specFile) {
  const spec = loadSpec(specFile);
  const buildDir = ensureDir(path.join(ROOT, "build", spec.name));
  log("plan", `${spec.title} — ${spec.segments.length} segments at ${spec.width}x${spec.height}, ${spec.fps} fps`);

  const timeline = await planTimeline(spec);
  log("plan", `Total length ${timeline.total.toFixed(1)}s`);

  const voice = await prepareMedia(spec, timeline, buildDir);

  let musicFile = null;
  if (spec.music?.file) {
    musicFile = path.resolve(ROOT, spec.music.file);
    if (!fs.existsSync(musicFile)) fail(`Music file not found: ${spec.music.file}`);
  } else if (spec.music?.query) {
    log("music", `Searching Openverse for "${spec.music.query}"…`);
    const { file, track } = await fetchMusicFor(spec.music.query, timeline.total);
    musicFile = file;
    log("music", `Using ${creditLine(track)}`);
  }
  await mixSoundtrack({ voice, musicFile, music: spec.music, total: timeline.total, out: path.join(buildDir, "soundtrack.wav") });

  writeComposition(spec, timeline, buildDir);
  log("hyperframes", `Composition written to ${rel(path.join(buildDir, "index.html"))}`);
  return { spec, buildDir };
}

const commands = {
  async make([file]) {
    if (!file) fail("Usage: npm run make -- edits/<name>.json");
    const { spec, buildDir } = await build(file);
    log("hyperframes", "Linting composition…");
    await hyperframes(["lint", buildDir]);
    const out = path.resolve(ROOT, spec.output);
    ensureDir(path.dirname(out));
    log("hyperframes", `Rendering → ${rel(out)} (this takes a while)…`);
    await hyperframes(["render", buildDir, "--output", out, "--quality", spec.quality, "--fps", String(spec.fps)]);
    log("done", `Video ready: ${out}`);
    const credits = path.join(ROOT, "assets", "music", "CREDITS.txt");
    if (spec.music?.query && fs.existsSync(credits)) log("done", `Music credits to paste into your description: ${rel(credits)}`);
  },

  async preview([file]) {
    if (!file) fail("Usage: npm run preview -- edits/<name>.json");
    const { buildDir } = await build(file);
    await hyperframes(["preview", buildDir]);
  },

  async new([name]) {
    if (!name || !/^[\w-]+$/.test(name)) fail("Usage: npm run new -- my-video   (letters, numbers, - and _ only)");
    const dest = path.join(ROOT, "edits", `${name}.json`);
    if (fs.existsSync(dest)) fail(`${rel(dest)} already exists.`);
    const tpl = JSON.parse(fs.readFileSync(path.join(ROOT, "edits", "template.json"), "utf8"));
    tpl.output = `output/${name}.mp4`;
    fs.writeFileSync(dest, JSON.stringify(tpl, null, 2) + "\n");
    log("new", `Created ${rel(dest)} — put your recordings in recordings/ and edit the "segments" list.`);
  },

  async music(args) {
    const getIdx = args.indexOf("--get");
    const pick = getIdx >= 0 ? parseInt(args[getIdx + 1], 10) : null;
    const query = args.filter((_, i) => getIdx < 0 || (i !== getIdx && i !== getIdx + 1)).join(" ");
    if (!query) fail('Usage: npm run music -- calm piano   (then: npm run music -- calm piano --get 2)');
    const tracks = await searchMusic(query);
    if (tracks.length === 0) fail(`No results for "${query}".`);
    if (pick) {
      const t = tracks[pick - 1];
      if (!t) fail(`Pick a number from 1 to ${tracks.length}.`);
      const file = await downloadTrack(t);
      log("music", `Saved ${rel(file)}. Use it with  "music": { "file": "${rel(file)}" }`);
      return;
    }
    tracks.forEach((t, i) => console.log(`${String(i + 1).padStart(2)}. ${t.title} — ${t.creator} (${t.seconds}s, ${t.license})\n    ${t.page}`));
    console.log('\nDownload one with --get N, or put  "music": { "query": "' + query + '" }  in your edit file.');
  },

  async record(args) {
    launchObs({ start: args.includes("--start") });
  },

  async sample() {
    const dir = ensureDir(path.join(ROOT, "samples"));
    log("sample", "Generating samples/screen-demo.mp4 (12s) and samples/talking-head.mp4 (8s)…");
    const speech = async (text, secs, out) => {
      try {
        await ffmpeg(["-f", "lavfi", "-i", `flite=text='${text}':voice=slt`, "-af", "apad", "-t", String(secs), out]);
      } catch {
        // FFmpeg build without flite: use short tone bursts as a stand-in for speech.
        await ffmpeg(["-f", "lavfi", "-i", `sine=f=330:d=${secs}`, "-af", "volume='if(lt(mod(t,1.2),0.7),0.5,0)':eval=frame", out]);
      }
    };
    const a1 = path.join(dir, "_a1.wav");
    const a2 = path.join(dir, "_a2.wav");
    await speech("This is a sample screen recording. The music gets quieter while I talk, and comes back up when I stop.", 12, a1);
    await speech("And this is the second clip, standing in for a webcam recording.", 8, a2);
    await ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=1920x1080:r=30:d=12", "-i", a1, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path.join(dir, "screen-demo.mp4")]);
    await ffmpeg(["-f", "lavfi", "-i", "mandelbrot=s=1280x720:r=30", "-i", a2, "-t", "8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", path.join(dir, "talking-head.mp4")]);
    fs.rmSync(a1); fs.rmSync(a2);
    log("sample", "Done. Now run:  npm run make -- edits/example.json");
  },

  async doctor() {
    const v = await run("ffmpeg", ["-version"], { quiet: true }).catch(() => null);
    console.log(v ? `✔ FFmpeg: ${v.split("\n")[0]}` : "✘ FFmpeg not found — winget install --id Gyan.FFmpeg -e");
    console.log(`✔ Node ${process.version}${parseInt(process.versions.node) < 22 ? "  (HyperFrames needs 22+)" : ""}`);
    await hyperframes(["doctor"]);
  },
};

const [cmd, ...args] = process.argv.slice(2);
if (!cmd || !commands[cmd]) {
  console.log(HELP);
  process.exit(cmd ? 1 : 0);
}
commands[cmd](args).catch((e) => fail(e.message));
