import { formatOnAir, isFollowingLive, liveLedSynced, playbackGlitch, rewindWindow, shouldSnapToLive } from "./buffer-math.mjs";
import { dueChimes, freshArrivals, nextPresence } from "./presence.mjs";
import { peekSecondsLeft, railAfterEmpty, railAfterEnter, railAfterInteract, railAfterTick, railAfterToggle, visualRailOpen } from "./rail-peek.mjs";
import { screenPhase } from "./screen-switch.mjs";

const loginView = document.querySelector("#login-view");
const passwordView = document.querySelector("#password-view");
const appView = document.querySelector("#app-view");
const loginForm = document.querySelector("#login-form");
const loginError = document.querySelector("#login-error");
const passwordForm = document.querySelector("#password-form");
const passwordError = document.querySelector("#password-error");
const settingsButton = document.querySelector("#settings");
const settingsPop = document.querySelector("#settings-pop");
const videoContainer = document.querySelector("#video-container");
const railWrap = document.querySelector("#rail-wrap");
const railToggle = document.querySelector("#rail-toggle");
const railCount = document.querySelector("#rail-count");
const rail = document.querySelector("#live-rail");
const peersEl = document.querySelector("#peers");
const hiddenLives = document.querySelector("#hidden-lives");
const empty = document.querySelector("#empty");
const count = document.querySelector("#count");
const logoutButton = document.querySelector("#logout");

const peers = new Map();
const catalog = new Map();
let presence = { primed: false, people: {} };
const CHIME_RECENT_KEY = "spartan-live-chime-recent";

function loadChimeRecent() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(CHIME_RECENT_KEY) || "{}");
    return saved && typeof saved === "object" ? saved : {};
  } catch {
    return {};
  }
}

function rememberChimes(recent) {
  chimeRecent = recent;
  try { sessionStorage.setItem(CHIME_RECENT_KEY, JSON.stringify(recent)); } catch { /* aba privada */ }
}

let chimeRecent = loadChimeRecent();
const CHIME_KEY = "spartan-live-chimes";
let soundCtx = null;
const soundBuffers = {};
let soundLoading = null;

function ensureSound() {
  if (appView.classList.contains("hidden")) return null;
  if (!soundCtx) soundCtx = new AudioContext();
  return soundCtx;
}

function loadSounds() {
  const ctx = ensureSound();
  if (!ctx) return Promise.resolve();
  if (soundLoading) return soundLoading;
  soundLoading = (async () => {
    for (const [kind, url] of [["enter", "/entrar.mp3"], ["exit", "/sair.mp3"]]) {
      const response = await fetch(url);
      const bytes = await response.arrayBuffer();
      soundBuffers[kind] = await ctx.decodeAudioData(bytes.slice(0));
    }
  })().catch(() => {
    soundLoading = null;
  });
  return soundLoading;
}

function unlockSound() {
  const ctx = ensureSound();
  if (!ctx) return;
  if (ctx.state === "suspended") ctx.resume();
  loadSounds();
}

document.addEventListener("pointerdown", unlockSound);

function chimesEnabled() {
  try { return localStorage.getItem(CHIME_KEY) !== "off"; } catch { return true; }
}

function paintChimeButton() {
  const button = document.querySelector("#chimes");
  if (!button) return;
  const on = chimesEnabled();
  button.textContent = on ? "Sons de entrada: ligados" : "Sons de entrada: desligados";
  button.classList.toggle("is-off", !on);
}

function playChime(kind) {
  const buffer = soundBuffers[kind];
  if (!chimesEnabled() || !buffer || !soundCtx || soundCtx.state !== "running") return false;
  const source = soundCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(soundCtx.destination);
  source.start();
  return true;
}

let pendingChime = null;
let chimeBusy = false;

function queueChime(kind, names) {
  if (appView.classList.contains("hidden") || !names.length || !chimesEnabled()) return;
  pendingChime = { kind, names: names.slice() };
}

async function flushChime(now) {
  if (appView.classList.contains("hidden") || !chimesEnabled()) {
    pendingChime = null;
    return;
  }
  if (!pendingChime || chimeBusy) return;
  const job = pendingChime;
  pendingChime = null;
  chimeBusy = true;
  try {
    try { await loadSounds(); } catch { return; }
    if (appView.classList.contains("hidden") || !soundCtx) return;
    if (soundCtx.state !== "running") {
      try { await soundCtx.resume(); } catch { return; }
    }
    if (appView.classList.contains("hidden") || soundCtx.state !== "running") return;
    const due = dueChimes(job.names.map((name) => `${job.kind}:${name}`), chimeRecent, now);
    if (!due.play.length) return;
    rememberChimes(due.recent);
    playChime(job.kind);
  } finally {
    chimeBusy = false;
  }
}
let manualFocus = null;
let autoFocus = false;

function showLogin() {
  pendingChime = null;
  stopAll();
  appView.classList.add("hidden");
  passwordView.classList.add("hidden");
  loginView.classList.remove("hidden");
}

function showPasswordGate() {
  pendingChime = null;
  stopAll();
  loginView.classList.add("hidden");
  appView.classList.add("hidden");
  passwordView.classList.remove("hidden");
}

function showApp() {
  loginView.classList.add("hidden");
  passwordView.classList.add("hidden");
  appView.classList.remove("hidden");
  unlockSound();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "falha");
    error.status = response.status;
    error.mustChange = Boolean(data.mustChange);
    throw error;
  }
  return data;
}

function visiblePeers() {
  return [...peers.values()].filter((peer) => !peer.hidden);
}

function visibleCount() {
  return visiblePeers().length;
}

function clearFocusMarks() {
  for (const peer of peers.values()) peer.el.classList.remove("peer-focus");
}

function showVideo() {
  const anyone = catalog.size > 0;
  empty.classList.toggle("hidden", anyone);
  videoContainer.classList.toggle("hidden", visibleCount() === 0);
}

function resizePeers() {
  if (videoContainer.classList.contains("peer-focus-mode")) return;
  peersEl.classList.remove("peers-split");
  const count = visibleCount();
  if (count <= 1) return;
  const slots = Math.min(50, count + (count % 2));
  peersEl.style.gridTemplateColumns = "1fr 1fr";
  peersEl.style.gridTemplateRows = `repeat(${slots / 2}, minmax(0, 1fr))`;
}

function syncLiveFocus() {
  const count = visibleCount();
  if (count === 0) {
    videoContainer.classList.remove("peer-focus-mode");
    delete videoContainer.dataset.spartanAutoFocus;
    autoFocus = false;
    manualFocus = null;
    clearFocusMarks();
    return;
  }
  if (count === 1) {
    const only = visiblePeers()[0];
    videoContainer.classList.add("peer-focus-mode");
    videoContainer.dataset.spartanAutoFocus = "1";
    autoFocus = true;
    manualFocus = null;
    clearFocusMarks();
    only.el.classList.add("peer-focus");
    return;
  }
  if (autoFocus || videoContainer.dataset.spartanAutoFocus === "1") {
    videoContainer.classList.remove("peer-focus-mode");
    delete videoContainer.dataset.spartanAutoFocus;
    autoFocus = false;
    clearFocusMarks();
  }
  const chosen = manualFocus ? peers.get(manualFocus) : null;
  if (!chosen || chosen.hidden) {
    manualFocus = null;
    if (!autoFocus) {
      videoContainer.classList.remove("peer-focus-mode");
      clearFocusMarks();
    }
    return;
  }
  videoContainer.classList.add("peer-focus-mode");
  delete videoContainer.dataset.spartanAutoFocus;
  autoFocus = false;
  clearFocusMarks();
  chosen.el.classList.add("peer-focus");
}

function renderHidden() {
  hiddenLives.replaceChildren();
  for (const [name, peer] of peers) {
    if (!peer.hidden) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `Ver ${name}`;
    button.addEventListener("click", () => {
      peer.hidden = false;
      peer.el.classList.remove("peer-hidden");
      refreshGrid();
    });
    hiddenLives.append(button);
  }
}

function refreshGrid() {
  const total = catalog.size;
  const online = [...catalog.values()].filter((entry) => !entry.offline).length;
  if (total === 0) count.textContent = "ninguém ao vivo";
  else if (online === 0) count.textContent = "reconectando";
  else count.textContent = online === 1 ? "1 ao vivo" : `${online} ao vivo`;
  count.classList.toggle("is-live", online > 0);
  count.classList.toggle("is-off", online === 0);
  showVideo();
  syncLiveFocus();
  resizePeers();
  renderHidden();
  renderRail();
  paintRail();
}

function renderRail() {
  rail.replaceChildren();
  for (const entry of catalog.values()) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = entry.name;
    if (peers.has(entry.name)) button.classList.add("on");
    if (entry.offline) button.classList.add("offline");
    button.addEventListener("click", () => toggleWatch(entry.name));
    rail.append(button);
  }
}

const RAIL_KEY = "spartan-live-rail";

function storedRailOpen() {
  try { return localStorage.getItem(RAIL_KEY) === "open"; } catch { return false; }
}

let railState = { storedOpen: storedRailOpen(), held: false, peekUntil: 0 };
let railHadNames = false;

function paintRail() {
  const now = Date.now();
  const open = visualRailOpen(railState, now);
  const seconds = peekSecondsLeft(railState, now);
  railWrap.classList.toggle("is-open", open);
  rail.classList.toggle("hidden", !open);
  railToggle.setAttribute("aria-expanded", open ? "true" : "false");
  const label = railToggle.querySelector(".rail-label");
  if (label) label.textContent = open ? "Ocultar" : "Lives";
  const dot = railToggle.querySelector(".rail-dot");
  if (dot) {
    const anyone = [...catalog.values()].some((entry) => !entry.offline);
    dot.classList.toggle("is-on", anyone);
    dot.classList.toggle("is-off", !anyone);
  }
  railCount.hidden = seconds <= 0;
  railCount.textContent = seconds > 0 ? `${seconds}s` : "";
}

function rememberRail() {
  try { localStorage.setItem(RAIL_KEY, railState.storedOpen ? "open" : "closed"); } catch { /* o navegador não guardou */ }
}

railToggle.addEventListener("click", () => {
  railState = railAfterToggle(railState, Date.now());
  rememberRail();
  paintRail();
});

function noteRailEnter(now) {
  railState = railAfterEnter(railState, now);
}

function noteRailEmpty() {
  const next = railAfterEmpty(railState);
  if (next === railState) return;
  railState = next;
  rememberRail();
}

function noteRailInteraction(event) {
  if (event.target instanceof Element && event.target.closest("#rail-toggle")) return;
  const next = railAfterInteract(railState, Date.now());
  if (next === railState) return;
  railState = next;
  paintRail();
}

document.addEventListener("pointerdown", noteRailInteraction);
document.addEventListener("keydown", noteRailInteraction);
document.addEventListener("wheel", noteRailInteraction, { passive: true });
window.setInterval(() => {
  if (!railState.peekUntil) return;
  const next = railAfterTick(railState, Date.now());
  if (next !== railState) railState = next;
  paintRail();
}, 200);
paintRail();

function toggleWatch(name) {
  if (peers.has(name)) removeStream(name);
  else addStream({ name });
  refreshGrid();
}

function silenceVideo(video) {
  try { video.pause(); } catch { /* já estava parado */ }
  try { video.srcObject = null; } catch { /* sem fluxo */ }
  try {
    video.removeAttribute("src");
    video.load();
  } catch { /* o elemento já saiu da página */ }
}

function attachStream(video, name, feeder) {
  const source = `/hls/${encodeURIComponent(name)}/index.m3u8`;
  if (window.Hls && Hls.isSupported()) {
    const hls = new Hls({
      lowLatencyMode: true,
      backBufferLength: 120,
      liveDurationInfinity: true,
      liveSyncDuration: 1.5,
      maxLiveSyncPlaybackRate: 1,
      maxAudioFramesDrift: 10,
    });
    hls.loadSource(source);
    hls.attachMedia(video);
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError();
        return;
      }
      hls.startLoad();
    });
    return {
      hls,
      feeder,
      stop() {
        try { hls.stopLoad(); } catch { /* a carga já tinha parado */ }
        try { hls.detachMedia(); } catch { /* o vídeo já soltou */ }
        try { hls.destroy(); } catch { /* já destruído */ }
        silenceVideo(video);
        if (feeder) silenceVideo(feeder);
      },
    };
  }
  video.src = source;
  return { hls: null, feeder, stop() { silenceVideo(video); if (feeder) silenceVideo(feeder); } };
}

function bindPeerUi(peer, name) {
  const video = peer.el.querySelector("video");
  video.addEventListener("loadedmetadata", () => {
    peer.el.classList.toggle("peer-portrait", video.videoHeight > video.videoWidth);
  });
  peer.el.addEventListener("click", (event) => {
    if (event.target.closest("button, .player-bar, .peer-actions")) return;
    if (document.fullscreenElement) return;
    if (visibleCount() < 2) return;
    if (manualFocus === name) {
      manualFocus = null;
      autoFocus = false;
      videoContainer.classList.remove("peer-focus-mode");
      delete videoContainer.dataset.spartanAutoFocus;
      clearFocusMarks();
      resizePeers();
      return;
    }
    manualFocus = name;
    autoFocus = false;
    refreshGrid();
  });
}

function playerGlyph(kind) {
  const img = document.createElement("img");
  img.alt = "";
  img.draggable = false;
  img.src = kind === "pause" ? "/pause.png" : "/play.png";
  return img;
}

function addStream(stream) {
  if (peers.has(stream.name)) return;
  const el = document.createElement("article");
  el.className = "peer paused";
  const video = document.createElement("video");
  video.className = "media";
  video.controls = false;
  video.autoplay = false;
  video.muted = true;
  video.volume = 1;
  video.playsInline = true;
  const feeder = document.createElement("video");
  feeder.muted = true;
  feeder.autoplay = false;
  feeder.playsInline = true;
  feeder.className = "feeder";
  const actions = document.createElement("div");
  actions.className = "peer-actions";
  const title = document.createElement("strong");
  title.textContent = stream.name;
  const close = document.createElement("button");
  close.type = "button";
  close.setAttribute("aria-label", "Parar de assistir");
  close.textContent = "X";
  const bar = document.createElement("div");
  bar.className = "player-bar";
  const play = document.createElement("button");
  play.type = "button";
  play.className = "play";
  play.append(playerGlyph("play"));
  const liveButton = document.createElement("button");
  liveButton.type = "button";
  liveButton.className = "live-led";
  liveButton.innerHTML = '<span class="led"></span> ao vivo';
  const volume = document.createElement("div");
  volume.className = "vol";
  const volumeButton = document.createElement("button");
  volumeButton.type = "button";
  volumeButton.className = "icon-btn";
  volumeButton.textContent = "🔇";
  const pop = document.createElement("div");
  pop.className = "vol-pop";
  const readout = document.createElement("span");
  readout.className = "vol-readout";
  readout.textContent = "0%";
  const track = document.createElement("div");
  track.className = "vol-track";
  track.tabIndex = 0;
  track.setAttribute("role", "slider");
  track.setAttribute("aria-label", "Volume");
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", "100");
  track.setAttribute("aria-valuenow", "0");
  const fill = document.createElement("div");
  fill.className = "vol-fill";
  const thumb = document.createElement("div");
  thumb.className = "vol-thumb";
  track.append(fill, thumb);
  pop.append(readout, track);
  volume.append(pop, volumeButton);
  const pip = document.createElement("button");
  pip.type = "button";
  pip.className = "icon-btn";
  pip.textContent = "PIP";
  pip.title = "Janela flutuante";
  const fullscreen = document.createElement("button");
  fullscreen.type = "button";
  fullscreen.className = "icon-btn";
  fullscreen.textContent = "⛶";
  fullscreen.title = "Tela cheia";
  const onAir = document.createElement("span");
  onAir.className = "on-air";
  onAir.title = "Tempo no ar";
  onAir.textContent = "0:00";
  bar.append(play, onAir, liveButton, volume, pip, fullscreen);
  const exitFs = document.createElement("button");
  exitFs.type = "button";
  exitFs.className = "fs-exit";
  exitFs.setAttribute("aria-label", "Sair da tela cheia");
  exitFs.textContent = "✕";
  let hideExit = 0;
  function showExit() {
    if (document.fullscreenElement !== el) return;
    el.classList.add("fs-hot");
    window.clearTimeout(hideExit);
    hideExit = window.setTimeout(() => el.classList.remove("fs-hot"), 1400);
  }
  let savedVolume = 100;
  function volumeStep() {
    if (video.muted || video.volume === 0) return 0;
    return Math.max(0, Math.min(100, Math.round(video.volume * 20) * 5));
  }
  function paintSound() {
    const step = volumeStep();
    fill.style.height = `${step}%`;
    thumb.style.bottom = `${step}%`;
    readout.textContent = `${step}%`;
    track.setAttribute("aria-valuenow", String(step));
    volumeButton.textContent = step === 0 ? "🔇" : "🔊";
  }
  function applyVolume(percent) {
    const step = Math.max(0, Math.min(100, Math.round(Number(percent) / 5) * 5));
    if (step > 0) savedVolume = step;
    video.volume = step / 100;
    video.muted = step === 0;
    paintSound();
  }
  function volumeFromPointer(event) {
    const rect = track.getBoundingClientRect();
    if (!rect.height) return;
    applyVolume((1 - (event.clientY - rect.top) / rect.height) * 100);
  }
  function paintPlay() {
    const paused = video.paused;
    play.replaceChildren(playerGlyph(paused ? "play" : "pause"));
    el.classList.toggle("paused", paused);
  }
  let pauseStarted = 0;
  let mediaLink = null;
  function liveRange() {
    const range = video.seekable;
    if (!range.length) return null;
    return rewindWindow(range.start(0), range.end(range.length - 1));
  }
  function liveEdge(box) {
    const sync = mediaLink?.hls?.liveSyncPosition;
    if (Number.isFinite(sync)) return sync;
    return box ? Math.max(box.start, box.end - 0.8) : null;
  }
  function paintLive() {
    const box = liveRange();
    const edge = liveEdge(box);
    const synced = Boolean(box) && Number.isFinite(edge) && liveLedSynced(video.currentTime, edge);
    liveButton.classList.toggle("synced", synced);
    liveButton.classList.toggle("late", !synced);
  }
  function paintOn() {
    const start = peer.readyAt || catalog.get(stream.name)?.readyAt;
    onAir.textContent = formatOnAir(start ? Date.now() - start : 0);
  }
  function paintTime() {
    paintLive();
    paintOn();
  }
  function ensureLink() {
    if (!link) openLink();
  }
  function goLive() {
    peer.started = true;
    peer.userPaused = false;
    peer.lastMove = Date.now();
    if (playbackGlitch(peer.highTime, video.currentTime)) {
      peer.glitchAt = Date.now();
      peer.highTime = 0;
      peer.lastMove = Date.now();
      peer.revive();
      return;
    }
    ensureLink();
    const edge = liveEdge(liveRange());
    if (Number.isFinite(edge)) {
      try { video.currentTime = edge; } catch { /* a live ainda está abrindo */ }
    }
    video.play().catch(() => {});
    paintTime();
  }
  function resumePlayback() {
    const held = pauseStarted ? (performance.now() - pauseStarted) / 1000 : 0;
    pauseStarted = 0;
    if (held >= 300) {
      goLive();
      return;
    }
    peer.userPaused = false;
    peer.started = true;
    peer.lastMove = Date.now();
    ensureLink();
    video.play().catch(() => {});
  }
  play.addEventListener("click", () => {
    if (!video.paused) {
      pauseStarted = performance.now();
      peer.userPaused = true;
      video.pause();
      return;
    }
    resumePlayback();
  });
  liveButton.addEventListener("click", goLive);
  volumeButton.addEventListener("click", () => {
    if (video.muted || video.volume === 0) {
      applyVolume(savedVolume || 100);
      video.play().catch(() => {});
      return;
    }
    applyVolume(0);
  });
  track.addEventListener("pointerdown", (event) => {
    track.setPointerCapture(event.pointerId);
    volumeFromPointer(event);
  });
  track.addEventListener("pointermove", (event) => {
    if (!track.hasPointerCapture(event.pointerId)) return;
    volumeFromPointer(event);
  });
  track.addEventListener("keydown", (event) => {
    const current = volumeStep();
    if (event.key === "ArrowUp" || event.key === "ArrowRight") applyVolume(current + 5);
    else if (event.key === "ArrowDown" || event.key === "ArrowLeft") applyVolume(current - 5);
    else if (event.key === "Home") applyVolume(0);
    else if (event.key === "End") applyVolume(100);
    else return;
    event.preventDefault();
  });
  pip.addEventListener("click", () => {
    if (document.pictureInPictureElement === video) document.exitPictureInPicture().catch(() => {});
    else video.requestPictureInPicture().catch(() => {});
  });
  fullscreen.addEventListener("click", () => {
    if (document.fullscreenElement === el) document.exitFullscreen();
    else el.requestFullscreen();
  });
  video.addEventListener("timeupdate", () => {
    paintTime();
    const box = liveRange();
    const edge = liveEdge(box);
    const behind = Number.isFinite(edge) ? edge - video.currentTime : 0;
    if (peer.started && !peer.userPaused && !video.paused && box && Number.isFinite(edge)) {
      const nearLive = isFollowingLive(video.currentTime, box.end, 10) && behind > 6;
      if (shouldSnapToLive(behind) || nearLive) {
        try { video.currentTime = edge; } catch { /* a janela ainda está abrindo */ }
      }
    }
    const current = mediaLink?.peer;
    if (!current) return;
  });
  video.addEventListener("progress", paintTime);
  video.addEventListener("play", () => {
    if (!peer.started) video.pause();
    else el.classList.add("has-frame");
    paintPlay();
  });
  video.addEventListener("pause", paintPlay);
  exitFs.addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen();
  });
  el.addEventListener("mousemove", showExit);
  el.addEventListener("pointerdown", () => {
    el.classList.add("show-chrome");
    window.clearTimeout(el._hideChrome);
    el._hideChrome = window.setTimeout(() => el.classList.remove("show-chrome"), 2800);
  });
  el.addEventListener("fullscreenchange", () => {
    if (document.fullscreenElement === el) showExit();
    else el.classList.remove("fs-hot");
  });
  const offlineNote = document.createElement("div");
  offlineNote.className = "offline-note";
  offlineNote.textContent = "Offline. Aguardando a reconexão.";
  const switchNote = document.createElement("div");
  switchNote.className = "switch-note";
  switchNote.textContent = "Trocando tela!";
  const bigPlay = document.createElement("button");
  bigPlay.type = "button";
  bigPlay.className = "big-play";
  bigPlay.append(playerGlyph("play"));
  bigPlay.title = "Dar play";
  bigPlay.addEventListener("click", () => resumePlayback());
  const poster = document.createElement("img");
  poster.className = "thumb is-empty";
  poster.alt = "";
  poster.draggable = false;
  const posterStamp = catalog.get(stream.name)?.thumbAt || 0;
  if (posterStamp) poster.src = `/api/thumb/${encodeURIComponent(stream.name)}?t=${posterStamp}`;
  poster.addEventListener("load", () => poster.classList.remove("is-empty"));
  poster.addEventListener("error", () => poster.classList.add("is-empty"));
  const peer = {
    el, hidden: false, mode: "live", sourceBuffer: null, pending: [], archiveUrl: "",
    queueAppend() {}, stop() {}, video, hls: null, feeder, userPaused: false,
    offline: false, offlineAt: 0, switching: false, lastTime: 0, lastMove: Date.now(), moves: 0,
    highTime: 0, glitchAt: 0,
    started: false, name: stream.name, readyAt: catalog.get(stream.name)?.readyAt || Date.now(),
    poster, posterStamp,
  };
  mediaLink = { peer, hls: null };
  close.addEventListener("click", () => {
    removeStream(stream.name);
    refreshGrid();
  });
  actions.append(title, close);
  el.append(video, poster, feeder, offlineNote, switchNote, bigPlay, actions, bar, exitFs);
  peersEl.append(el);
  let link = null;
  function openLink() {
    if (link) {
      try { link.stop(); } catch { /* a carga anterior já tinha parado */ }
    }
    link = attachStream(video, stream.name, feeder);
    mediaLink.hls = link.hls;
    peer.hls = link.hls;
    peer.link = link;
  }
  peer.revive = () => {
    peer.highTime = 0;
    peer.lastMove = Date.now();
    clearOffline(peer);
    if (!peer.started || peer.userPaused) {
      if (link) {
        try { link.stop(); } catch { /* já estava parado */ }
        link = null;
        peer.hls = null;
        mediaLink.hls = null;
      }
      return;
    }
    openLink();
    video.play().catch(() => {});
  };
  function noteGlitch() {
    const now = Date.now();
    if (peer.glitchAt && now - peer.glitchAt < 8000) return;
    peer.glitchAt = now;
    peer.highTime = 0;
    peer.lastMove = now;
    peer.revive();
  }
  video.addEventListener("timeupdate", () => {
    if (!peer.started || peer.userPaused || video.paused || peer.switching || peer.offline) return;
    const time = video.currentTime;
    if (playbackGlitch(peer.highTime, time)) {
      noteGlitch();
      return;
    }
    if (time > (peer.highTime || 0)) peer.highTime = time;
    peer.lastTime = time;
    peer.lastMove = Date.now();
  });
  const clock = window.setInterval(paintOn, 1000);
  video.pause();
  peer.stop = () => {
    window.clearInterval(clock);
    if (document.pictureInPictureElement === video) document.exitPictureInPicture().catch(() => {});
    if (document.fullscreenElement === el) document.exitFullscreen().catch(() => {});
    if (link) {
      try { link.stop(); } catch { /* a carga já tinha parado */ }
      link = null;
    }
    silenceVideo(video);
    silenceVideo(feeder);
    peer.hls = null;
    mediaLink.hls = null;
  };
  peers.set(stream.name, peer);
  bindPeerUi(peer, stream.name);
}

function removeStream(name) {
  const peer = peers.get(name);
  if (!peer) return;
  peer.stop();
  peer.el.remove();
  peers.delete(name);
  if (manualFocus === name) manualFocus = null;
  if (document.fullscreenElement === videoContainer && visibleCount() === 0) {
    document.exitFullscreen().catch(() => {});
  }
}

function stopAll() {
  for (const name of [...peers.keys()]) removeStream(name);
  refreshGrid();
}

const OFFLINE_WAIT_MS = 90000;

function markSwitch(peer) {
  if (!peer || peer.switching) return;
  peer.switching = true;
  peer.el.classList.remove("is-offline");
  peer.el.classList.add("is-switching");
  if (peer.mode !== "archive") {
    try { peer.hls?.stopLoad(); } catch { /* a imagem fica no último quadro */ }
  }
}

function clearSwitch(peer) {
  if (!peer) return;
  peer.switching = false;
  peer.el.classList.remove("is-switching");
}

function markOffline(peer) {
  if (!peer || peer.offline) return;
  peer.offline = true;
  peer.offlineAt = Date.now();
  peer.moves = 0;
  peer.el.classList.add("is-offline");
  if (peer.mode !== "archive") {
    try { peer.hls?.stopLoad(); } catch { /* a live já estava parada */ }
  }
}

function clearOffline(peer) {
  peer.offline = false;
  peer.offlineAt = 0;
  peer.moves = 0;
  peer.el.classList.remove("is-offline");
}

function noteProgress(peer) {
  const video = peer.video;
  if (!video || peer.userPaused || peer.mode === "archive" || !peer.started || video.paused) return;
  if (peer.switching || peer.offline) return;
  const time = video.currentTime;
  const frozen = Date.now() - peer.lastMove > 4000;
  if (!playbackGlitch(peer.highTime, time) && !frozen) {
    if (Math.abs(time - peer.lastTime) > 0.05) {
      peer.lastTime = time;
      peer.lastMove = Date.now();
    }
    return;
  }
  const now = Date.now();
  if (peer.glitchAt && now - peer.glitchAt < 8000) return;
  peer.glitchAt = now;
  peer.highTime = 0;
  peer.lastMove = now;
  if (peer.revive) peer.revive();
}

async function refresh() {
  try {
    const data = await api("/api/streams");
    const known = new Set(catalog.keys());
    const stopped = new Set(data.stopped || []);
    const switching = new Set(data.switching || []);
    const liveNames = data.streams.map((stream) => stream.name).filter((name) => !stopped.has(name));
    const presentNames = [...new Set([...liveNames, ...switching])];
    const step = nextPresence(presence, presentNames, [...stopped], Date.now());
    const arrived = freshArrivals(step.enter, known);
    presence = { primed: step.primed, people: step.people };
    const now = Date.now();
    if (arrived.length) noteRailEnter(now);
    const readyAt = new Map(data.streams.map((stream) => [stream.name, Date.parse(stream.readyTime || "")]));
    const thumbAt = new Map(data.streams.map((stream) => [stream.name, Number(stream.thumbAt) || 0]));
    for (const name of stopped) {
      catalog.delete(name);
      removeStream(name);
    }
    const live = new Set(liveNames);
    const seen = new Set([...live, ...switching, ...catalog.keys()]);
    for (const name of seen) {
      if (stopped.has(name)) continue;
      const current = catalog.get(name) || { name, offline: false, offlineAt: 0, switching: false };
      const previousReady = current.readyAt;
      if (Number.isFinite(readyAt.get(name))) current.readyAt = readyAt.get(name);
      if (thumbAt.get(name)) current.thumbAt = thumbAt.get(name);
      const phase = screenPhase(current, live.has(name), switching.has(name), now, OFFLINE_WAIT_MS, previousReady);
      if (phase.action === "drop") {
        catalog.delete(name);
        removeStream(name);
        continue;
      }
      if (!catalog.has(name) && !live.has(name) && !switching.has(name)) continue;
      catalog.set(name, phase.entry);
      const peer = peers.get(name);
      if (Number.isFinite(phase.entry.readyAt) && peer) peer.readyAt = phase.entry.readyAt;
      const posterStamp = Number(phase.entry.thumbAt) || 0;
      if (peer?.poster && posterStamp && peer.posterStamp !== posterStamp) {
        peer.posterStamp = posterStamp;
        peer.poster.src = `/api/thumb/${encodeURIComponent(name)}?t=${posterStamp}`;
      }
      if (phase.action === "switch") markSwitch(peer);
      else if (phase.action === "revive") {
        clearSwitch(peer);
        if (peer?.revive) peer.revive();
      } else if (phase.action === "offline") {
        clearSwitch(peer);
        markOffline(peer);
      } else if (peer) {
        clearSwitch(peer);
        noteProgress(peer);
      }
    }
    if (railHadNames && catalog.size === 0) noteRailEmpty();
    railHadNames = catalog.size > 0;
    refreshGrid();
    if (step.exit.length) queueChime("exit", step.exit);
    else queueChime("enter", arrived);
    await flushChime(now);
  } catch (error) {
    if (error.mustChange) {
      showPasswordGate();
      return;
    }
    if (error.status === 401) {
      showLogin();
      return;
    }
    count.textContent = error.message || "Não consegui falar com o motor.";
  }
}

async function changePassword(form, errorEl) {
  errorEl.textContent = "";
  const fields = new FormData(form);
  await api("/api/password", {
    method: "POST",
    body: JSON.stringify({
      current: fields.get("current"),
      next: fields.get("next"),
      again: fields.get("again"),
    }),
  });
  form.reset();
}

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (document.fullscreenElement) return;
  if (visibleCount() <= 1) return;
  if (!manualFocus) return;
  manualFocus = null;
  autoFocus = false;
  videoContainer.classList.remove("peer-focus-mode");
  delete videoContainer.dataset.spartanAutoFocus;
  clearFocusMarks();
  resizePeers();
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";
  const form = new FormData(loginForm);
  try {
    const data = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        user: form.get("user"),
        password: form.get("password"),
      }),
    });
    if (data.mustChange) showPasswordGate();
    else {
      showApp();
      await refresh();
    }
  } catch (error) {
    loginError.textContent = error.message;
  }
});

passwordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await changePassword(passwordForm, passwordError);
    showApp();
    await refresh();
  } catch (error) {
    passwordError.textContent = error.message;
  }
});

function placeSettings() {
  const rect = settingsButton.getBoundingClientRect();
  const width = Math.min(240, window.innerWidth - 16);
  const top = Math.min(rect.bottom + 8, window.innerHeight - 8);
  settingsPop.style.position = "fixed";
  settingsPop.style.width = `${width}px`;
  settingsPop.style.top = `${top}px`;
  settingsPop.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
  settingsPop.style.left = "auto";
}

settingsButton.addEventListener("click", (event) => {
  event.stopPropagation();
  const opening = settingsPop.classList.contains("hidden");
  settingsPop.classList.toggle("hidden");
  if (opening) {
    placeSettings();
    paintChimeButton();
  }
});

const gridButton = document.querySelector("#grid-fullscreen");
const gridExit = document.querySelector("#grid-exit");
let hideGridExit = 0;
function showGridExit() {
  if (document.fullscreenElement !== videoContainer) return;
  videoContainer.classList.add("grid-hot");
  window.clearTimeout(hideGridExit);
  hideGridExit = window.setTimeout(() => videoContainer.classList.remove("grid-hot"), 1400);
}
gridButton.addEventListener("click", () => {
  if (visibleCount() === 0) return;
  if (document.fullscreenElement === videoContainer) {
    document.exitFullscreen();
    return;
  }
  videoContainer.requestFullscreen().catch(() => {});
});
gridExit.addEventListener("click", () => {
  if (document.fullscreenElement === videoContainer) document.exitFullscreen();
});
videoContainer.addEventListener("mousemove", showGridExit);
videoContainer.addEventListener("fullscreenchange", () => {
  if (document.fullscreenElement === videoContainer) showGridExit();
  else videoContainer.classList.remove("grid-hot");
});

document.querySelector("#chimes").addEventListener("click", (event) => {
  event.stopPropagation();
  try { localStorage.setItem(CHIME_KEY, chimesEnabled() ? "off" : "on"); } catch { /* o navegador não guardou */ }
  paintChimeButton();
});

document.addEventListener("click", (event) => {
  if (settingsPop.classList.contains("hidden")) return;
  if (settingsPop.contains(event.target) || event.target === settingsButton) return;
  settingsPop.classList.add("hidden");
});

document.querySelector("#gear-password").addEventListener("submit", async (event) => {
  event.preventDefault();
  const errorEl = document.querySelector("#gear-error");
  try {
    await changePassword(event.currentTarget, errorEl);
    errorEl.textContent = "Senha trocada.";
  } catch (error) {
    errorEl.textContent = error.message;
  }
});

document.querySelector("#download").addEventListener("click", async () => {
  const note = document.querySelector("#download-note");
  note.textContent = "";
  try {
    const probe = await fetch("/download/SpartanLive.exe", { method: "HEAD", credentials: "same-origin" });
    if (!probe.ok) {
      note.textContent = "O programa de transmitir ainda não está disponível para baixar.";
      return;
    }
    const link = document.createElement("a");
    link.href = "/download/SpartanLive.exe";
    link.download = "SpartanLive.exe";
    document.body.append(link);
    link.click();
    link.remove();
    note.textContent = "O download do programa começou.";
  } catch {
    note.textContent = "Não consegui baixar o programa.";
  }
});

logoutButton.addEventListener("click", async () => {
  await api("/api/logout", { method: "POST", body: "{}" });
  showLogin();
});

const timer = window.setInterval(() => {
  if (!appView.classList.contains("hidden")) refresh();
}, 3000);

window.addEventListener("pagehide", () => window.clearInterval(timer));

api("/api/me")
  .then((me) => {
    if (me.mustChange) {
      showPasswordGate();
      return;
    }
    showApp();
    return refresh();
  })
  .catch(() => showLogin());
