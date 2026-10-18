"use strict";

const API_BASE = location.origin;

const layerA = document.getElementById("layerA");
const layerB = document.getElementById("layerB");
const layers = [layerA, layerB];
const hint = document.getElementById("hint");
const statusBox = document.getElementById("status");
const badge = document.getElementById("badge");
const screen = document.getElementById("screen");

const FADE_MS = 1200;
const FAST_FADE_MS = 350;
const IMG_TIMEOUT_MS = 20000;
const CONFIG_REFRESH_MS = 15000;
const TOP_SCREEN_MS = 12000;
const QR_SCREEN_MS = 15000;

let active = 0;
let allPhotos = [];
const known = new Set();
let normal = [];
let incoming = [];
const newSinceStart = new Set();
let shownThisRun = 0;
let firstShown = false;

let slideMs = 6000;
let pollMs = 5000;
let minShowMs = 1500;
let priorityNew = true;
let showOverlay = true;
let kenBurns = false;
let albumTitle = "";
let albumUrl = "";
let total = 0;

let titleText = "";
let titleSeconds = 8;
let endLoopEnabled = false;
let endFilmEnabled = false;
let endFilmSeconds = 1.0;
let topUploadersEnabled = true;
let topUploadersCount = 10;
let qrUploadEnabled = false;
let qrCornerEnabled = false;
let qrCornerPos = "tr";
let paused = false;
let resetFlag = false;

let statusTimer = null;
let pollTimer = null;
let refreshing = false;
let interruptResolve = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sleepP(ms) {
  return new Promise((resolve) => {
    let left = ms;
    let last = Date.now();
    const tick = () => {
      if (resetFlag) { resolve(); return; }
      const now = Date.now();
      if (!paused) left -= now - last;
      last = now;
      if (left <= 0) resolve();
      else setTimeout(tick, Math.min(left, 250));
    };
    setTimeout(tick, Math.min(left, 250));
  });
}

function setStatus(text, isError, flash) {
  statusBox.textContent = text;
  statusBox.classList.toggle("err", !!isError);
  statusBox.classList.toggle("flash", !!flash);
  statusBox.classList.remove("hidden");
}

function formatDuration(ms) {
  const sec = ms / 1000;
  if (sec < 60) return Math.round(sec) + " s";
  const min = sec / 60;
  if (min < 60) return (Number.isInteger(min) ? min : min.toFixed(1).replace(".", ",")) + " min";
  const h = min / 60;
  return (Number.isInteger(h) ? h : h.toFixed(1).replace(".", ",")) + " u";
}

function refreshStatus() {
  if (!showOverlay) {
    statusBox.classList.add("hidden");
    return;
  }
  if (paused) {
    setStatus("\u23F8 PAUZE \u00B7 druk op p om te hervatten", false, false);
    clearTimeout(statusTimer);
    return;
  }
  const parts = [];
  if (albumTitle) parts.push(albumTitle);
  parts.push(total + " foto's");
  if (total > 0 && slideMs > 0) parts.push("ronde \u2248 " + formatDuration(total * slideMs));
  parts.push(incoming.length + normal.length + " in wachtrij");
  setStatus(parts.join("  ·  "), false, false);
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => statusBox.classList.add("hidden"), 6000);
}

function flashNew(count) {
  if (paused) return;
  setStatus("\uD83C\uDF89 " + count + " nieuwe foto" + (count > 1 ? "'s" : "") + "!", false, true);
  clearTimeout(statusTimer);
  statusTimer = setTimeout(refreshStatus, 6000);
}

function loadImage(img, src) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; reject(new Error("timeout")); }
    }, IMG_TIMEOUT_MS);
    img.onload = () => { if (!done) { done = true; clearTimeout(timer); resolve(); } };
    img.onerror = () => { if (!done) { done = true; clearTimeout(timer); reject(new Error("laadfout")); } };
    img.src = src;
    if (img.complete && img.naturalWidth > 0) { clearTimeout(timer); done = true; resolve(); }
  });
}

function preloadNext() {
  const next = incoming.length ? incoming[0] : normal[0];
  if (next) { const pre = new Image(); pre.src = next.src; }
}

function resetLayer(img) {
  img.style.transition = "";
  img.style.transform = "";
  img.style.transformOrigin = "";
}

function applyKenBurns(img, totalMs, fadeMs) {
  const origins = ["0% 0%", "100% 0%", "0% 100%", "100% 100%", "50% 50%"];
  const o = origins[Math.floor(Math.random() * origins.length)];
  const zoomIn = Math.random() < 0.5;
  img.style.transformOrigin = o;
  img.style.transition = "none";
  img.style.transform = zoomIn ? "scale(1.0)" : "scale(1.12)";
  void img.offsetWidth;
  img.style.transition = `transform ${totalMs}ms linear, opacity ${fadeMs}ms ease-in-out`;
  img.style.transform = zoomIn ? "scale(1.12)" : "scale(1.0)";
}

function waitSlide(ms) {
  return new Promise((resolve) => {
    let left = ms;
    let last = Date.now();
    let timer = null;
    const done = () => { clearTimeout(timer); interruptResolve = null; resolve(); };
    const tick = () => {
      if (resetFlag) { done(); return; }
      const now = Date.now();
      if (!paused) left -= now - last;
      last = now;
      if (left <= 0) { done(); return; }
      timer = setTimeout(tick, Math.min(left, 250));
    };
    timer = setTimeout(tick, Math.min(left, 250));
    interruptResolve = () => {
      const elapsed = ms - left;
      const rem = minShowMs - elapsed;
      if (rem <= 0) { done(); }
      else { left = Math.min(left, rem); }
    };
  });
}

function triggerInterrupt() {
  if (paused) return;
  if (interruptResolve) { const fn = interruptResolve; interruptResolve = null; fn(); }
}

async function display(photo, opts) {
  opts = opts || {};
  const ms = opts.ms != null ? opts.ms : slideMs;
  const fade = opts.fadeMs != null ? opts.fadeMs : FADE_MS;
  const useKB = opts.kenBurns != null ? opts.kenBurns : kenBurns;
  const cur = layers[active];
  const next = layers[(active + 1) % 2];
  next.classList.remove("visible");
  resetLayer(next);
  try {
    await loadImage(next, photo.src);
  } catch (e) {
    return;
  }
  if (useKB) applyKenBurns(next, ms + fade, fade);
  else next.style.transition = `opacity ${fade}ms ease-in-out`;
  next.classList.add("visible");
  cur.classList.remove("visible");
  active = (active + 1) % 2;
  if (!opts.suppressBadge && photo.fresh) badge.classList.add("show");
  else badge.classList.remove("show");
  if (!firstShown) { firstShown = true; hint.classList.add("gone"); }
  if (opts.interruptible === false) await sleepP(ms);
  else await waitSlide(ms);
  badge.classList.remove("show");
}

async function refresh(initial) {
  if (refreshing) return 0;
  refreshing = true;
  let data;
  try {
    const url = API_BASE + (initial ? "/api/photos?fresh=1" : "/api/photos");
    data = await (await fetch(url, { cache: "no-store" })).json();
  } catch (e) {
    setStatus("verbinding met server mislukt: " + e.message, true, false);
    refreshing = false;
    return 0;
  }
  refreshing = false;
  if (data.error) {
    setStatus("album-fout: " + data.error, true, false);
    return 0;
  }
  albumTitle = data.title || albumTitle;
  allPhotos = data.photos || [];
  total = allPhotos.length;
  let added = 0;
  for (const p of allPhotos) {
    if (known.has(p.id)) continue;
    known.add(p.id);
    if (!initial && priorityNew) {
      p.fresh = true;
      incoming.push(p);
      newSinceStart.add(p.id);
    }
    added++;
  }
  if (incoming.length > 1) incoming.sort((a, b) => b.ts - a.ts);
  if (added > 0 && !initial) {
    flashNew(added);
    if (priorityNew) triggerInterrupt();
  } else {
    refreshStatus();
  }
  return added;
}

// ---------- schermen ----------

let screenToken = 0;

function showScreen(innerHtml, seconds) {
  const my = ++screenToken;
  screen.innerHTML = innerHtml;
  screen.classList.add("show");
  return sleepP(seconds * 1000).then(() => {
    if (my === screenToken) screen.classList.remove("show");
    return sleepP(700);
  });
}

function showTitle() {
  if (!titleText) return Promise.resolve();
  const markup = escapeHtml(titleText)
    .replace(/\\n/g, "\n")
    .replace(/\r?\n/g, "<br>");
  const html = `<div class="inner"><div class="title-text">${markup}</div></div>`;
  return showScreen(html, titleSeconds);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function topUploaders() {
  const counts = new Map();
  const avatars = new Map();
  for (const p of allPhotos) {
    const name = p.uploader || "Onbekend";
    counts.set(name, (counts.get(name) || 0) + 1);
    if (p.avatar && !avatars.has(name)) avatars.set(name, p.avatar);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topUploadersCount);
}

function showTopUploaders() {
  const list = topUploaders();
  if (!list.length) return Promise.resolve();
  const rows = list.map(([name, count], i) => {
    const img = topAvatarFor(name);
    return `<li class="${i === 0 ? "first" : ""}">
      <span class="rank">${i + 1}</span>
      ${img}
      <span class="name">${escapeHtml(name)}</span>
      <span class="count">${count}</span>
    </li>`;
  }).join("");
  const html = `<div class="inner"><h2>Top uploaders vanavond</h2><ol class="toplist">${rows}</ol></div>`;
  return showScreen(html, TOP_SCREEN_MS / 1000);
}

function topAvatarFor(name) {
  for (const p of allPhotos) {
    if ((p.uploader || "Onbekend") === name && p.avatar) {
      return `<img src="${escapeHtml(p.avatar)}" alt="">`;
    }
  }
  return "";
}

function showQR() {
  const url = albumUrl;
  const fallback = "https://api.qrserver.com/v1/create-qr-code/?size=600x600&margin=16&data=" + encodeURIComponent(url);
  const html = `<div class="inner qr">
    <h2>\uD83D\uDCF8 Deel jouw foto's!</h2>
    <img class="qr-img" src="/qr.png" alt="QR"
         onerror="this.onerror=null;this.src='${escapeHtml(fallback)}'">
    <div class="qr-url">${escapeHtml(url)}</div>
  </div>`;
  return showScreen(html, QR_SCREEN_MS / 1000);
}

async function playEndSequence() {
  if (endFilmEnabled) {
    const film = allPhotos.filter((p) => newSinceStart.has(p.id));
    for (const p of film) {
      if (resetFlag) return;
      await display(p, {
        ms: endFilmSeconds * 1000,
        fadeMs: FAST_FADE_MS,
        kenBurns: false,
        interruptible: false,
        suppressBadge: true,
      });
    }
  }
  if (resetFlag) return;
  if (topUploadersEnabled) await showTopUploaders();
  if (resetFlag) return;
  if (qrUploadEnabled) await showQR();
}

async function startRun() {
  await refresh(true);
  const incomingIds = new Set(incoming.map((p) => p.id));
  normal = allPhotos.filter((p) => !incomingIds.has(p.id));
  shownThisRun = 0;
  await showTitle();
}

async function loadConfig() {
  let cfg;
  try {
    cfg = await (await fetch(API_BASE + "/api/config", { cache: "no-store" })).json();
  } catch (e) {
    return;
  }
  if (cfg.slide_seconds) slideMs = Math.max(1, Number(cfg.slide_seconds)) * 1000;
  if (typeof cfg.show_overlay === "boolean") showOverlay = cfg.show_overlay;
  if (typeof cfg.priority_new === "boolean") priorityNew = cfg.priority_new;
  if (typeof cfg.ken_burns === "boolean") kenBurns = cfg.ken_burns;
  if (cfg.min_show_seconds != null) minShowMs = Math.max(0, Number(cfg.min_show_seconds) * 1000);
  if (typeof cfg.title_text === "string") titleText = cfg.title_text;
  if (cfg.title_seconds) titleSeconds = Math.max(1, Number(cfg.title_seconds));
  if (typeof cfg.end_loop_enabled === "boolean") endLoopEnabled = cfg.end_loop_enabled;
  if (typeof cfg.end_film_enabled === "boolean") endFilmEnabled = cfg.end_film_enabled;
  if (cfg.end_film_seconds != null) endFilmSeconds = Math.max(0.2, Number(cfg.end_film_seconds));
  if (typeof cfg.top_uploaders_enabled === "boolean") topUploadersEnabled = cfg.top_uploaders_enabled;
  if (cfg.top_uploaders_count) topUploadersCount = Math.max(1, Number(cfg.top_uploaders_count));
  if (typeof cfg.qr_upload_enabled === "boolean") qrUploadEnabled = cfg.qr_upload_enabled;
  if (typeof cfg.qr_corner_enabled === "boolean") qrCornerEnabled = cfg.qr_corner_enabled;
  if (typeof cfg.qr_corner_pos === "string" && ["tl", "tr", "bl", "br"].includes(cfg.qr_corner_pos)) {
    qrCornerPos = cfg.qr_corner_pos;
  }
  if (typeof cfg.album_url === "string") albumUrl = cfg.album_url;
  applyCornerQr();
  const newPoll = Math.max(2, Number(cfg.poll_seconds) || 5) * 1000;
  if (newPoll !== pollMs) { pollMs = newPoll; startPolling(); }
}

function applyCornerQr() {
  const el = document.getElementById("cornerQr");
  document.body.classList.remove("qr-tl", "qr-tr", "qr-bl", "qr-br");
  if (!qrCornerEnabled) { el.hidden = true; return; }
  if (!el.src) {
    const fallback = "https://api.qrserver.com/v1/create-qr-code/?size=400x400&margin=8&data=" + encodeURIComponent(albumUrl);
    el.src = "/qr.png";
    el.onerror = () => { el.onerror = null; el.src = fallback; };
  }
  el.className = "pos-" + qrCornerPos;
  el.hidden = false;
  document.body.classList.add("qr-" + qrCornerPos);
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => refresh(false), pollMs);
}

async function loop() {
  await loadConfig();
  startPolling();
  await startRun();
  setInterval(loadConfig, CONFIG_REFRESH_MS);
  while (true) {
    if (resetFlag) {
      resetFlag = false;
      paused = false;
      known.clear();
      newSinceStart.clear();
      incoming = [];
      normal = [];
      shownThisRun = 0;
      firstShown = false;
      badge.classList.remove("show");
      await startRun();
      continue;
    }
    while (paused && !resetFlag) await sleep(100);
    if (resetFlag) continue;
    if (normal.length === 0 && incoming.length === 0) {
      if (endLoopEnabled) {
        await playEndSequence();
        if (resetFlag) continue;
        await startRun();
        continue;
      }
      await refresh(false);
      if (normal.length === 0 && incoming.length === 0) {
        if (showOverlay && !paused) setStatus("wachten op nieuwe foto's\u2026", false, false);
        await sleepP(1000);
      }
      continue;
    }
    const photo = incoming.length ? incoming.shift() : normal.shift();
    shownThisRun++;
    preloadNext();
    await display(photo);
  }
}

function goFullscreen() {
  const el = document.documentElement;
  if (!document.fullscreenElement && el.requestFullscreen) el.requestFullscreen().catch(() => {});
  hint.classList.add("gone");
}

const helpBox = document.getElementById("help");

function toggleHelp() {
  helpBox.hidden = !helpBox.hidden;
}

function togglePause() {
  paused = !paused;
  clearTimeout(statusTimer);
  refreshStatus();
}

document.addEventListener("click", goFullscreen);
helpBox.addEventListener("click", (e) => { e.stopPropagation(); toggleHelp(); });
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const key = (e.key || "").toLowerCase();
  if (key === "escape") {
    if (!helpBox.hidden) toggleHelp();
    return;
  }
  if (key.length !== 1) return;
  goFullscreen();
  if (key === "i") {
    showOverlay = !showOverlay;
    refreshStatus();
    if (!showOverlay) statusBox.classList.add("hidden");
  } else if (key === "h") {
    toggleHelp();
  } else if (key === "p") {
    togglePause();
  } else if (key === "r") {
    resetFlag = true;
  } else if (key === "c") {
    window.open(API_BASE + "/config", "_blank");
  } else if (key === "s") {
    showQR();
  }
});

let cursorTimer = null;
document.addEventListener("mousemove", () => {
  document.getElementById("stage").classList.add("showcursor");
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(
    () => document.getElementById("stage").classList.remove("showcursor"),
    2000
  );
});

loop();
