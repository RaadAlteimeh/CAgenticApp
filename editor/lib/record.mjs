// Recording stage: launches OBS Studio (free, open-source replacement for Tella).
import fs from "node:fs";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
import { ROOT, log, ensureDir } from "./util.mjs";

function findObs() {
  const candidates = [
    process.env.OBS_PATH,
    "C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe",
    "C:\\Program Files (x86)\\Steam\\steamapps\\common\\OBS Studio\\bin\\64bit\\obs64.exe",
  ];
  try {
    const reg = execSync(
      'powershell -NoProfile -Command "Get-ItemProperty HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*, HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* -EA SilentlyContinue | ? { $_.DisplayName -like \'OBS*\' -and $_.InstallLocation } | % InstallLocation"',
      { encoding: "utf8", windowsHide: true },
    );
    for (const loc of reg.split(/\r?\n/).filter(Boolean)) candidates.push(path.join(loc.trim(), "bin", "64bit", "obs64.exe"));
  } catch { /* registry lookup is best-effort */ }
  return candidates.find((p) => p && fs.existsSync(p));
}

export function launchObs({ start = false } = {}) {
  const exe = findObs();
  if (!exe) throw new Error("OBS Studio not found. Install it with: winget install --id OBSProject.OBSStudio -e  (or set OBS_PATH).");
  const recordings = ensureDir(path.join(ROOT, "recordings"));
  log("record", `Opening OBS${start ? " and starting a recording" : ""}…`);
  log("record", `Tip: in OBS → Settings → Output → Recording Path, choose:\n         ${recordings}`);
  const args = ["--disable-shutdown-check"];
  if (start) args.push("--startrecording");
  // OBS must be launched from its own folder so it can find its data files.
  spawn(exe, args, { cwd: path.dirname(exe), detached: true, stdio: "ignore" }).unref();
}
