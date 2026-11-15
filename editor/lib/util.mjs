// Shared helpers: running processes, paths, logging.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function log(step, msg) {
  console.log(`\x1b[36m[${step}]\x1b[0m ${msg}`);
}

export function fail(msg) {
  console.error(`\x1b[31mError:\x1b[0m ${msg}`);
  process.exit(1);
}

/** Run a command, streaming output unless quiet. Resolves with captured stdout. */
export function run(cmd, args, { cwd = ROOT, quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; if (!quiet) process.stdout.write(d); });
    child.stderr.on("data", (d) => { err += d; if (!quiet) process.stderr.write(d); });
    child.on("error", (e) => reject(new Error(`Could not start "${cmd}": ${e.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`"${cmd}" exited with code ${code}\n${err.split("\n").slice(-15).join("\n")}`));
    });
  });
}

export const ffmpeg = (args, opts) => run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { quiet: true, ...opts });

export async function probe(file) {
  const out = await run("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", file], { quiet: true });
  const j = JSON.parse(out);
  return {
    duration: parseFloat(j.format?.duration ?? "0"),
    hasVideo: j.streams.some((s) => s.codec_type === "video"),
    hasAudio: j.streams.some((s) => s.codec_type === "audio"),
  };
}

/** Run the locally installed HyperFrames CLI with the current Node binary (no shell needed on Windows). */
export function hyperframes(args, opts) {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("hyperframes/package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const bin = path.join(path.dirname(pkgPath), typeof pkg.bin === "string" ? pkg.bin : pkg.bin.hyperframes);
  return run(process.execPath, [bin, ...args], opts);
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");
