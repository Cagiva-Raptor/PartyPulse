"use strict";

const layerA = document.getElementById("layerA");
const layerB = document.getElementById("layerB");
const layers = [layerA, layerB];
const hint = document.getElementById("hint");
const statusBox = document.getElementById("status");
const badge = document.getElementById("badge");

const IMG_TIMEOUT_MS = 20000;
const CONFIG_REFRESH_MS = 15000;

let minShowMs = 1500;
let interruptResolve = null;

let active = 0;
let normal = [];
let incoming = [];
const seen = new Set();
let slideMs = 6000;
let pollMs = 5000;
let priorityNew = true;
let showOverlay = true;
let albumTitle = "";
let total = 0;
let firstShown = false;
let statusTimer = null;
let pollTimer = null;
let refreshing = false;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
  if (min < 60) {
    return (Number.isInteger(min) ? min : min.toFixed(1).replace(".", ",")) + " min";
  }
  const hours = min / 60;
  return (Number.isInteger(hours) ? hours : hours.toFixed(1).replace(".", ",")) + " u";
}

function refreshStatus() {
  if (!showOverlay) {
    statusBox.classList.add("hidden");
    return;
  }
  const parts = [];
  if (albumTitle) parts.push(albumTitle);
  parts.push(total + " foto's");
  if (total > 0 && slideMs > 0) {
    parts.push("ronde \u2248 " + formatDuration(total * slideMs));
  }
  parts.push(incoming.length + normal.length + " in wachtrij");
  setStatus(parts.join("  ·  "), false, false);
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => statusBox.classList.add("hidden"), 6000);
}

function flashNew(count) {
  setStatus("\uD83C\uDF89 " + count + " nieuwe foto" + (count > 1 ? "'s" : "") + "!", false, true);
  clearTimeout(statusTimer);
  statusTimer = setTimeout(refreshStatus, 6000);
}

function loadImage(img, src) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        reject(new Error("timeout"));
      }
    }, IMG_TIMEOUT_MS);
    img.onload = () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve();
      }
    };
    img.onerror = () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(new Error("laadfout"));
      }
    };
    img.src = src;
    if (img.complete && img.naturalWidth > 0) {
      clearTimeout(timer);
      done = true;
      resolve();
    }
  });
}

function preloadNext() {
  const next = incoming.length > 0 ? incoming[0] : normal[0];
  if (next) {
    const pre = new Image();
    pre.src = next.src;
  }
}

async function display(photo) {
  const cur = layers[active];
  const next = layers[(active + 1) % 2];
  try {
    await loadImage(next, photo.src);
  } catch (e) {
    return;
  }
  next.classList.add("visible");
  cur.classList.remove("visible");
  active = (active + 1) % 2;
  badge.classList.toggle("show", !!photo.fresh);
  if (!firstShown) {
    firstShown = true;
    hint.classList.add("gone");
  }
  await waitSlide(slideMs);
  badge.classList.remove("show");
}

function waitSlide(ms) {
  return new Promise((resolve) => {
    const started = Date.now();
    let timer = null;
    const done = () => {
      clearTimeout(timer);
      interruptResolve = null;
      resolve();
    };
    timer = setTimeout(done, ms);
    interruptResolve = () => {
      const left = minShowMs - (Date.now() - started);
      if (left <= 0) {
        done();
      } else {
        clearTimeout(timer);
        timer = setTimeout(done, left);
      }
    };
  });
}

function triggerInterrupt() {
  if (interruptResolve) {
    const fn = interruptResolve;
    interruptResolve = null;
    fn();
  }
}

async function refresh(initial) {
  if (refreshing) return 0;
  refreshing = true;
  let data;
  try {
    const url = initial ? "/api/photos?fresh=1" : "/api/photos";
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
  total = data.photos.length;
  let added = 0;
  for (const p of data.photos) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    if (!initial && priorityNew) {
      p.fresh = true;
      incoming.push(p);
    } else {
      normal.push(p);
    }
    added++;
  }
  if (incoming.length > 1) {
    incoming.sort((a, b) => b.ts - a.ts);
  }
  if (added > 0 && !initial) {
    flashNew(added);
    if (priorityNew) triggerInterrupt();
  } else {
    refreshStatus();
  }
  return added;
}

async function loadConfig() {
  let cfg;
  try {
    cfg = await (await fetch("/api/config", { cache: "no-store" })).json();
  } catch (e) {
    return;
  }
  if (cfg.slide_seconds) slideMs = Math.max(1, Number(cfg.slide_seconds)) * 1000;
  if (typeof cfg.show_overlay === "boolean") showOverlay = cfg.show_overlay;
  if (typeof cfg.priority_new === "boolean") priorityNew = cfg.priority_new;
  if (cfg.min_show_seconds) {
    minShowMs = Math.max(0, Number(cfg.min_show_seconds) * 1000);
  }
  const newPoll = Math.max(2, Number(cfg.poll_seconds) || 5) * 1000;
  if (newPoll !== pollMs) {
    pollMs = newPoll;
    startPolling();
  }
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => refresh(false), pollMs);
}

async function loop() {
  await loadConfig();
  startPolling();
  await refresh(true);
  setInterval(loadConfig, CONFIG_REFRESH_MS);
  while (true) {
    if (incoming.length === 0 && normal.length === 0) {
      if (showOverlay) setStatus("wachten op nieuwe foto's\u2026", false, false);
      await sleep(1000);
      continue;
    }
    const photo = incoming.length > 0 ? incoming.shift() : normal.shift();
    preloadNext();
    await display(photo);
  }
}

function goFullscreen() {
  const el = document.documentElement;
  if (!document.fullscreenElement && el.requestFullscreen) {
    el.requestFullscreen().catch(() => {});
  }
  hint.classList.add("gone");
}

document.addEventListener("click", goFullscreen);
document.addEventListener("keydown", (e) => {
  goFullscreen();
  if (e.key === "i") {
    showOverlay = !showOverlay;
    refreshStatus();
    if (!showOverlay) statusBox.classList.add("hidden");
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
