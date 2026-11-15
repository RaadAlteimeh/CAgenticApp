// HyperFrames stage: writes the HTML composition (index.html) that HyperFrames renders to MP4.
// Format reference: https://hyperframes.heygen.com/reference/html-schema
import fs from "node:fs";
import path from "node:path";
import { bare } from "./transcribe.mjs";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const n3 = (x) => Number(x.toFixed(3));
const pct = (v) => `${(v * 100).toFixed(1)}%`;

/** Group words into short subtitle lines (max ~4 words / 26 chars, break on punctuation and pauses). */
function chunkWords(words) {
  const chunks = [];
  let cur = [];
  const flush = () => { if (cur.length) chunks.push(cur); cur = []; };
  for (const [i, w] of words.entries()) {
    const prev = words[i - 1];
    const len = cur.reduce((s, x) => s + x.text.length + 1, 0);
    if (cur.length && (cur.length >= 4 || len + w.text.length > 26 || /[.!?]$/.test(prev.text) || w.start - prev.end > 0.45)) flush();
    cur.push(w);
  }
  flush();
  return chunks;
}

/** Scale/transform-origin keyframes for one video: alternating punch-in on jump cuts + authored zooms. */
function zoomTweens(id, seg, at) {
  const out = [];
  const focus = { x: 0.5, y: 0.45, ...(seg.focus ?? {}) };
  const origin = (f) => `${pct(f.x)} ${pct(f.y)}`;
  const cutScale = seg.zoomCuts === false ? 1 : typeof seg.zoomCuts === "number" ? seg.zoomCuts : 1.12;
  const zooms = [...seg.zooms].sort((a, b) => a.at - b.at).filter((z, i, arr) => i === 0 || z.at >= arr[i - 1].end + 0.35);
  const busy = (t) => zooms.some((z) => t > z.at - 0.1 && t < z.end + 0.45);

  // Base scale toggles on each jump cut (classic "zoom cut" that hides the jump), except during authored zooms.
  const baseChanges = [{ t: 0, s: 1 }];
  if (cutScale !== 1) {
    let s = 1;
    for (const c of seg.cutsAt) {
      if (busy(c)) continue;
      s = s === 1 ? cutScale : 1;
      baseChanges.push({ t: c, s });
      out.push(`tl.set("#${id}", { scale: ${s} }, ${n3(at + c)});`);
    }
  }
  const baseAt = (t) => baseChanges.filter((b) => b.t <= t).at(-1).s;

  for (const z of zooms) {
    const b = baseAt(z.at);
    const target = n3(b * (z.scale ?? 1.3));
    const f = { x: z.x ?? focus.x, y: z.y ?? focus.y };
    const punch = (z.mode ?? "punch") === "punch";
    const inDur = punch ? 0.22 : n3(Math.min(2.5, (z.end - z.at) * 0.85));
    // fromTo with explicit start values: frames are rendered by parallel workers that seek out of order.
    out.push(`tl.fromTo("#${id}", { scale: ${b}, transformOrigin: "${origin(focus)}" }, { scale: ${target}, transformOrigin: "${origin(f)}", duration: ${inDur}, ease: "${punch ? "power3.out" : "sine.inOut"}", immediateRender: false }, ${n3(at + z.at)});`);
    out.push(`tl.fromTo("#${id}", { scale: ${target}, transformOrigin: "${origin(f)}" }, { scale: ${b}, transformOrigin: "${origin(focus)}", duration: 0.4, ease: "power2.inOut", immediateRender: false }, ${n3(at + z.end)});`);
  }
  return { tweens: out, focusOrigin: origin(focus) };
}

export function writeComposition(spec, timeline, buildDir) {
  const { width: W, height: H, fps, theme } = spec;
  const total = n3(timeline.total);
  const tr = spec.transition;
  const els = [];
  const anim = [];
  const styles = [];

  for (const seg of timeline.segments) {
    const n = seg.index + 1;
    const at = n3(seg.at);
    const dur = n3(seg.duration);
    const fade = Math.min(tr, dur / 4);

    if (seg.type === "clip") {
      const { tweens, focusOrigin } = zoomTweens(`v${n}`, seg, at);
      styles.push(`#v${n} { transform-origin: ${focusOrigin}; }`);
      els.push(`<video id="v${n}" class="clip media" src="clips/seg${n}.mp4" data-start="${at}" data-duration="${dur}" data-track-index="0" muted playsinline></video>`);
      anim.push(`tl.fromTo("#v${n}", { opacity: 0 }, { opacity: 1, duration: ${fade}, ease: "none" }, ${at});`);
      anim.push(...tweens);
      anim.push(`tl.to("#v${n}", { opacity: 0, duration: ${fade}, ease: "none" }, ${n3(at + dur - fade)});`);

      // Word-by-word subtitles: each line appears with the first word, the spoken word lights up.
      const keywords = new Set((seg.keywords ?? []).map(bare));
      chunkWords(seg.words).forEach((chunk, k, all) => {
        const id = `s${n}_${k + 1}`;
        const cAt = n3(at + chunk[0].start);
        const next = all[k + 1];
        const cEnd = Math.min(next ? next[0].start : chunk.at(-1).end + 0.6, chunk.at(-1).end + 0.8, dur);
        const cDur = n3(Math.max(0.2, at + cEnd - cAt));
        const spans = chunk.map((w, j) => `<span id="${id}w${j}" class="w${keywords.has(bare(w.text)) ? " kw" : ""}">${esc(w.text)}</span>`).join("");
        els.push(`<div id="${id}" class="clip sub-layer" data-start="${cAt}" data-duration="${cDur}" data-track-index="4"><div id="${id}line" class="sub-line">${spans}</div></div>`);
        anim.push(`tl.fromTo("#${id}line", { opacity: 0, y: 18, scale: 0.94 }, { opacity: 1, y: 0, scale: 1, duration: 0.14, ease: "power2.out" }, ${cAt});`);
        chunk.forEach((w, j) => {
          const wAt = n3(at + w.start);
          anim.push(`tl.to("#${id}w${j}", { color: "${theme.highlight}", scale: 1.14, duration: 0.08, ease: "power2.out" }, ${wAt});`);
          anim.push(`tl.to("#${id}w${j}", { color: "${keywords.has(bare(w.text)) ? theme.accent : theme.text}", scale: 1, duration: 0.12, ease: "power1.out" }, ${n3(Math.max(wAt + 0.09, at + w.end))});`);
        });
      });

      // Simple caption boxes (one per line of text) — shown at the top when subtitles are on.
      (seg.captions ?? []).forEach((c, k) => {
        const id = `c${n}_${k + 1}`;
        const cAt = n3(at + c.at);
        const cDur = n3(Math.min(c.duration ?? dur, dur - c.at));
        if (cDur <= 0) return;
        els.push(`<div id="${id}" class="clip caption-layer${seg.words.length ? " top" : ""}" data-start="${cAt}" data-duration="${cDur}" data-track-index="2"><div id="${id}box" class="caption">${esc(c.text)}</div></div>`);
        const io = Math.min(0.35, cDur / 4);
        anim.push(`tl.fromTo("#${id}box", { y: 40, opacity: 0 }, { y: 0, opacity: 1, duration: ${io}, ease: "power3.out" }, ${n3(cAt + 0.1)});`);
        anim.push(`tl.to("#${id}box", { y: 20, opacity: 0, duration: ${io}, ease: "power2.in" }, ${n3(cAt + cDur - io - 0.05)});`);
      });

      // Callouts: "card" = labelled lower-left info card, "big" = huge centred word for hype moments.
      (seg.callouts ?? []).forEach((c, k) => {
        const id = `k${n}_${k + 1}`;
        const cAt = n3(at + c.at);
        const cDur = n3(Math.min(c.duration, dur - c.at));
        if (cDur <= 0.2) return;
        if (c.style === "big") {
          els.push(`<div id="${id}" class="clip big-layer" data-start="${cAt}" data-duration="${cDur}" data-track-index="5"><div id="${id}t" class="big-text">${esc(c.text)}</div></div>`);
          anim.push(`tl.fromTo("#${id}t", { scale: 0.4, opacity: 0, rotation: -6 }, { scale: 1, opacity: 1, rotation: 0, duration: 0.35, ease: "back.out(2.2)" }, ${cAt});`);
          anim.push(`tl.to("#${id}t", { scale: 1.15, opacity: 0, duration: 0.25, ease: "power2.in" }, ${n3(cAt + cDur - 0.27)});`);
        } else {
          els.push(
            `<div id="${id}" class="clip card-layer" data-start="${cAt}" data-duration="${cDur}" data-track-index="5"><div id="${id}c" class="card">` +
            (c.label ? `<div class="card-label">${esc(c.label)}</div>` : "") + `<div class="card-text">${esc(c.text)}</div></div></div>`,
          );
          anim.push(`tl.fromTo("#${id}c", { x: -80, opacity: 0 }, { x: 0, opacity: 1, duration: 0.4, ease: "power3.out" }, ${cAt});`);
          anim.push(`tl.to("#${id}c", { x: -40, opacity: 0, duration: 0.3, ease: "power2.in" }, ${n3(cAt + cDur - 0.32)});`);
        }
      });
    } else {
      els.push(
        `<section id="t${n}" class="clip title-card" data-start="${at}" data-duration="${n3(seg.duration)}" data-track-index="1">` +
        `<div class="title-inner"><div id="t${n}bar" class="accent-bar"></div>` +
        `<h1 id="t${n}h">${esc(seg.text)}</h1>` +
        (seg.subtitle ? `<p id="t${n}p">${esc(seg.subtitle)}</p>` : "") +
        `</div></section>`,
      );
      anim.push(`tl.fromTo("#t${n}", { opacity: 0 }, { opacity: 1, duration: ${fade}, ease: "none" }, ${at});`);
      anim.push(`tl.fromTo("#t${n}bar", { scaleX: 0 }, { scaleX: 1, duration: 0.6, ease: "power3.out" }, ${n3(at + 0.15)});`);
      anim.push(`tl.fromTo("#t${n}h", { y: 60, opacity: 0 }, { y: 0, opacity: 1, duration: 0.7, ease: "power3.out" }, ${n3(at + 0.25)});`);
      if (seg.subtitle) anim.push(`tl.fromTo("#t${n}p", { y: 30, opacity: 0 }, { y: 0, opacity: 1, duration: 0.6, ease: "power3.out" }, ${n3(at + 0.5)});`);
      anim.push(`tl.to("#t${n}", { opacity: 0, duration: ${fade}, ease: "none" }, ${n3(at + dur - fade)});`);
    }
  }

  els.push(`<audio id="soundtrack" src="soundtrack.wav" data-start="0" data-duration="${total}" data-track-index="3" data-volume="1"></audio>`);

  const u = (px) => Math.round(px * (H / 1080)); // keep sizes proportional for 4K / vertical
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=${W}, height=${H}" />
<title>${esc(spec.title)}</title>
<!-- Generated by editor/lib/compose.mjs from ${esc(path.basename(spec.file))} — edit the JSON, not this file. -->
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>
  html, body { margin: 0; background: ${theme.background}; }
  #root { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; background: ${theme.background}; font-family: ${theme.font}; }
  .clip { position: absolute; inset: 0; }
  /* Everything starts hidden; the GSAP timeline reveals each element at its start time. */
  .media { width: 100%; height: 100%; object-fit: cover; z-index: 1; opacity: 0; }
  .title-card { opacity: 0; z-index: 2; display: grid; place-items: center; background: radial-gradient(ellipse at 30% 20%, ${theme.accent}33, transparent 60%), ${theme.background}; }
  .title-inner { text-align: center; max-width: 80%; }
  .accent-bar { width: ${u(140)}px; height: ${Math.max(4, u(8))}px; margin: 0 auto ${u(36)}px; background: ${theme.accent}; border-radius: 99px; transform-origin: center; }
  .title-card h1 { margin: 0; color: ${theme.text}; font-size: ${u(104)}px; line-height: 1.05; font-weight: 800; letter-spacing: -0.02em; }
  .title-card p { margin: ${u(28)}px 0 0; color: ${theme.text}cc; font-size: ${u(40)}px; font-weight: 500; }

  .sub-layer { z-index: 4; display: flex; align-items: flex-end; justify-content: center; padding-bottom: ${u(70)}px; box-sizing: border-box; }
  .sub-line { opacity: 0; max-width: 86%; text-align: center; font-size: ${u(66)}px; font-weight: 900; line-height: 1.15; color: ${theme.text}; text-transform: uppercase; letter-spacing: 0.01em;
              -webkit-text-stroke: ${Math.max(2, u(7))}px #000; paint-order: stroke fill; text-shadow: 0 ${u(6)}px ${u(18)}px rgba(0,0,0,0.55); }
  .sub-line .w { display: inline-block; margin: 0 0.16em; }
  .sub-line .kw { color: ${theme.accent}; }

  .caption-layer { z-index: 3; display: flex; align-items: flex-end; justify-content: center; padding-bottom: ${u(80)}px; box-sizing: border-box; }
  .caption-layer.top { align-items: flex-start; padding: ${u(60)}px 0 0; }
  .caption { opacity: 0; max-width: 78%; padding: ${u(18)}px ${u(34)}px; border-radius: ${u(16)}px; background: rgba(8, 10, 16, 0.78); border-left: ${Math.max(3, u(6))}px solid ${theme.accent}; color: ${theme.text}; font-size: ${u(44)}px; font-weight: 600; line-height: 1.25; text-align: center; }

  .card-layer { z-index: 5; display: flex; align-items: flex-start; justify-content: flex-start; padding: ${u(70)}px 0 0 ${u(80)}px; box-sizing: border-box; }
  .card { opacity: 0; padding: ${u(20)}px ${u(32)}px; border-radius: ${u(18)}px; background: rgba(10, 12, 20, 0.82); border: ${Math.max(1, u(2))}px solid ${theme.accent}88; box-shadow: 0 ${u(12)}px ${u(40)}px rgba(0,0,0,0.45); }
  .card-label { color: ${theme.accent}; font-size: ${u(28)}px; font-weight: 800; letter-spacing: 0.18em; text-transform: uppercase; margin-bottom: ${u(6)}px; }
  .card-text { color: ${theme.text}; font-size: ${u(48)}px; font-weight: 800; }

  .big-layer { z-index: 6; display: grid; place-items: center; }
  .big-text { opacity: 0; font-size: ${u(220)}px; font-weight: 900; color: ${theme.highlight}; text-transform: uppercase; letter-spacing: -0.02em;
              -webkit-text-stroke: ${Math.max(3, u(10))}px #000; paint-order: stroke fill; text-shadow: 0 0 ${u(60)}px ${theme.highlight}88, 0 ${u(10)}px ${u(30)}px rgba(0,0,0,0.6); }
  ${styles.join("\n  ")}
</style>
</head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${total}" data-width="${W}" data-height="${H}" data-fps="${fps}">
${els.map((e) => "  " + e).join("\n")}
</div>
<script>
  window.__timelines = window.__timelines || {};
  const tl = gsap.timeline({ paused: true });
${anim.map((a) => "  " + a).join("\n")}
  window.__timelines["main"] = tl;
</script>
</body>
</html>
`;
  const out = path.join(buildDir, "index.html");
  fs.writeFileSync(out, html);
  return out;
}
