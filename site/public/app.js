import { formatOnAir, isFollowingLive, liveLedSynced, playbackGlitch, rewindWindow, shouldSnapToLive } from "./buffer-math.mjs";
import { dueChimes, freshArrivals, nextPresence } from "./presence.mjs";
import { peekSecondsLeft, railAfterEmpty, railAfterEnter, railAfterInteract, railAfterTick, railAfterToggle, visualRailOpen } from "./rail-peek.mjs";
import { claimReturn, pruneReturns, rememberReturn } from "./quick-return.mjs";
import { screenPhase } from "./screen-switch.mjs";
import {
  HAPPY_GIFS,
  MAX_SAVED_VOLUME_STEP,
  MAX_VOLUME_STEP,
  SAD_GIFS,
  capPlayStartVolume,
  clampVolumeStep,
  createTheaterState,
  createToastQueue,
  dismissActiveToast,
  enqueueArrivalToasts,
  pickNextGif,
  readPeerVolume,
  savePeerVolume,
  shouldUseArrivalToast,
  theaterActive,
  theaterAfterEscape,
  theaterAfterMove,
  theaterAfterTick,
  theaterAfterToggle,
  theaterHeaderVisible,
  tickToastQueue,
} from "./theater.mjs";

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
const emptyGif = document.querySelector("#empty-gif");
const emptyText = document.querySelector("#empty-text");
const count = document.querySelector("#count");
const logoutButton = document.querySelector("#logout");
const theaterButton = document.querySelector("#theater-toggle");

const SAD_INDEX_KEY = "spartan-live-sad-gif-idx";
const HAPPY_INDEX_KEY = "spartan-live-happy-gif-idx";

function readStoredGifIndex(key, total) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return Math.floor(Math.random() * total) - 1;
    const parsed = Number.parseInt(raw, 10);
    return Number.isInteger(parsed) ? parsed : -1;
  } catch {
    return -1;
  }
}

function saveStoredGifIndex(key, index) {
  try { localStorage.setItem(key, String(index)); } catch { /* sem armazenamento */ }
}

let sadGifIndex = readStoredGifIndex(SAD_INDEX_KEY, SAD_GIFS.length);
let happyGifIndex = readStoredGifIndex(HAPPY_INDEX_KEY, HAPPY_GIFS.length);
let currentEmptyMode = "";

function advanceSadGif() {
  const picked = pickNextGif(SAD_GIFS, sadGifIndex);
  sadGifIndex = picked.index;
  saveStoredGifIndex(SAD_INDEX_KEY, sadGifIndex);
  currentEmptyMode = "sad";
  if (emptyGif) {
    emptyGif.classList.remove("is-broken");
    emptyGif.src = picked.src;
  }
}

function advanceHappyGif() {
  const picked = pickNextGif(HAPPY_GIFS, happyGifIndex);
  happyGifIndex = picked.index;
  saveStoredGifIndex(HAPPY_INDEX_KEY, happyGifIndex);
  currentEmptyMode = "happy";
  if (emptyGif) {
    emptyGif.classList.remove("is-broken");
    emptyGif.src = picked.src;
  }
}

if (emptyGif) {
  emptyGif.addEventListener("error", () => emptyGif.classList.add("is-broken"));
  emptyGif.addEventListener("load", () => emptyGif.classList.remove("is-broken"));
  advanceSadGif();
}

const VOLUME_MAP_KEY = "spartan-live-peer-volumes";
function loadVolumeMap() {
  try {
    const raw = JSON.parse(localStorage.getItem(VOLUME_MAP_KEY) || "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}
function persistVolumeMap(map) {
  try { localStorage.setItem(VOLUME_MAP_KEY, JSON.stringify(map)); } catch { /* sem armazenamento */ }
}
let peerVolumes = loadVolumeMap();
let hoveredPeer = null;
let theaterState = createTheaterState();
let toastState = createToastQueue();

const arrivalToast = document.createElement("button");
arrivalToast.type = "button";
arrivalToast.className = "arrival-toast hidden";
arrivalToast.setAttribute("aria-live", "polite");
const arrivalToastDot = document.createElement("span");
arrivalToastDot.className = "arrival-toast-dot";
const arrivalToastText = document.createElement("span");
arrivalToastText.className = "arrival-toast-text";
arrivalToast.append(arrivalToastDot, arrivalToastText);
if (appView) appView.append(arrivalToast);

function syncToastMount() {
  const host = document.fullscreenElement || appView || document.body;
  if (host && arrivalToast.parentElement !== host) {
    host.append(arrivalToast);
  }
}

function paintArrivalToast() {
  syncToastMount();
  const active = toastState.active;
  if (!active || appView?.classList.contains("hidden")) {
    arrivalToast.classList.add("hidden");
    arrivalToast.dataset.peer = "";
    return;
  }
  arrivalToast.dataset.peer = active.name;
  arrivalToastText.textContent = `${active.name} entrou online — clique para assistir`;
  arrivalToast.classList.remove("hidden");
}

function openToastStream(name) {
  if (!name || !catalog.has(name)) return;
  const existing = peers.get(name);
  if (existing) {
    if (existing.hidden) {
      existing.hidden = false;
      existing.el.classList.remove("peer-hidden");
    }
    refreshGrid();
    existing.resume?.();
    return;
  }
  addStream({ name });
  refreshGrid();
  const created = peers.get(name);
  created?.resume?.();
}

arrivalToast.addEventListener("click", (event) => {
  event.stopPropagation();
  const targetName = arrivalToast.dataset.peer || toastState.active?.name || "";
  toastState = dismissActiveToast(toastState, Date.now());
  paintArrivalToast();
  if (targetName) openToastStream(targetName);
});

document.addEventListener("fullscreenchange", () => {
  syncToastMount();
});

window.setInterval(() => {
  if (!toastState.active && (!toastState.queue || toastState.queue.length === 0)) return;
  const next = tickToastQueue(toastState, Date.now());
  if (next !== toastState) {
    toastState = next;
    paintArrivalToast();
  }
}, 200);

const peers = new Map();
const catalog = new Map();
let presence = { primed: false, people: {} };
let returns = {};
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
let rawSoundBytes = null;
let rawSoundPromise = null;
let currentChimeSource = null;
const chimeAudioEls = {
  enter: typeof Audio !== "undefined" ? new Audio("/entrar.mp3") : null,
  exit: typeof Audio !== "undefined" ? new Audio("/sair.mp3") : null,
};
for (const el of Object.values(chimeAudioEls)) {
  if (el) el.preload = "auto";
}

function fetchRawSounds() {
  if (rawSoundBytes) return Promise.resolve(rawSoundBytes);
  if (rawSoundPromise) return rawSoundPromise;
  rawSoundPromise = (async () => {
    const out = {};
    for (const [kind, url] of [["enter", "/entrar.mp3"], ["exit", "/sair.mp3"]]) {
      const response = await fetch(url);
      if (response.ok) out[kind] = await response.arrayBuffer();
    }
    rawSoundBytes = out;
    return out;
  })().catch(() => {
    rawSoundPromise = null;
    return null;
  });
  return rawSoundPromise;
}

function ensureSound() {
  if (!soundCtx && typeof AudioContext !== "undefined") soundCtx = new AudioContext();
  return soundCtx;
}

function loadSounds() {
  const ctx = ensureSound();
  if (!ctx) return Promise.resolve();
  if (soundBuffers.enter && soundBuffers.exit) return Promise.resolve();
  if (soundLoading) return soundLoading;
  soundLoading = (async () => {
    const raw = await fetchRawSounds();
    if (!raw) {
      soundLoading = null;
      return;
    }
    for (const kind of ["enter", "exit"]) {
      if (raw[kind] && !soundBuffers[kind]) {
        soundBuffers[kind] = await ctx.decodeAudioData(raw[kind].slice(0));
      }
    }
  })().catch(() => {
    soundLoading = null;
  });
  return soundLoading;
}

function unlockSound() {
  const ctx = ensureSound();
  if (ctx && ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }
  loadSounds();
  if (pendingChime && !chimeBusy) {
    flushChime(Date.now());
  }
}

for (const ev of ["pointerdown", "mousedown", "keydown", "touchstart", "click"]) {
  document.addEventListener(ev, unlockSound, { passive: true });
}
window.addEventListener("focus", () => {
  if (pendingChime && !chimeBusy) flushChime(Date.now());
});

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

function stopActiveChime() {
  if (currentChimeSource) {
    try { currentChimeSource.stop(); } catch { /* já parou */ }
    currentChimeSource = null;
  }
  for (const other of Object.values(chimeAudioEls)) {
    if (other && !other.paused) {
      try {
        other.pause();
        other.currentTime = 0;
      } catch { /* já parado */ }
    }
  }
}

async function playChime(kind) {
  if (!chimesEnabled()) return false;
  const el = chimeAudioEls[kind];
  if (el) {
    try {
      stopActiveChime();
      el.currentTime = 0;
      await el.play();
      return true;
    } catch { /* fallback para AudioContext se bloqueado ou falhou */ }
  }
  const ctx = ensureSound();
  if (ctx) {
    if (ctx.state === "suspended") {
      try {
        await Promise.race([
          ctx.resume(),
          new Promise((_, reject) => setTimeout(reject, 120)),
        ]);
      } catch { /* ainda suspenso sem clique na página */ }
    }
    if (ctx.state === "running") {
      try {
        await Promise.race([
          loadSounds(),
          new Promise((_, reject) => setTimeout(reject, 400)),
        ]);
      } catch { /* segue */ }
      const buffer = soundBuffers[kind];
      if (buffer) {
        try {
          stopActiveChime();
          const source = ctx.createBufferSource();
          source.buffer = buffer;
          source.connect(ctx.destination);
          currentChimeSource = source;
          source.onended = () => {
            if (currentChimeSource === source) currentChimeSource = null;
          };
          source.start();
          return true;
        } catch {
          return false;
        }
      }
    }
  }
  return false;
}

let pendingChime = null;
let chimeBusy = false;

function queueChime(kind, names) {
  if (appView.classList.contains("hidden") || !names.length || !chimesEnabled()) return;
  pendingChime = { kind, names: names.slice(), queuedAt: Date.now() };
}

async function flushChime(now) {
  if (appView.classList.contains("hidden") || !chimesEnabled()) {
    pendingChime = null;
    return;
  }
  if (!pendingChime || chimeBusy) return;
  if (now - (pendingChime.queuedAt || now) > 15_000) {
    pendingChime = null;
    return;
  }
  const job = pendingChime;
  chimeBusy = true;
  try {
    if (appView.classList.contains("hidden")) {
      pendingChime = null;
      return;
    }
    const due = dueChimes(job.names.map((name) => `${job.kind}:${name}`), chimeRecent, now);
    if (!due.play.length) {
      if (pendingChime === job) pendingChime = null;
      return;
    }
    const played = await playChime(job.kind);
    if (played) {
      rememberChimes(due.recent);
      if (pendingChime === job) pendingChime = null;
    }
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
  fetchRawSounds();
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
  const watching = visibleCount() > 0;
  const anyoneOnline = [...catalog.values()].some((entry) => !entry.offline);
  empty.classList.toggle("hidden", watching);
  videoContainer.classList.toggle("hidden", !watching);
  if (!watching) {
    if (anyoneOnline) {
      if (emptyText) emptyText.textContent = "Tem gente ao vivo! Escolha uma live ao lado para assistir.";
      if (currentEmptyMode !== "happy") advanceHappyGif();
    } else {
      if (emptyText) emptyText.textContent = "Ninguém está transmitindo agora.";
      if (currentEmptyMode !== "sad") advanceSadGif();
    }
  }
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
    const nameSpan = document.createElement("span");
    nameSpan.textContent = entry.name;
    button.append(nameSpan);
    if (Number(entry.viewers) > 0) {
      const badge = document.createElement("span");
      badge.className = "rail-viewers";
      badge.textContent = `👁 ${entry.viewers}`;
      button.append(badge);
    }
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
    if (document.fullscreenElement && document.fullscreenElement !== videoContainer) return;
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
  const viewersBadge = document.createElement("span");
  viewersBadge.className = "peer-viewers hidden";
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
  track.setAttribute("aria-valuemax", String(MAX_VOLUME_STEP));
  track.setAttribute("aria-valuenow", "0");
  const fill = document.createElement("div");
  fill.className = "vol-fill";
  const thumb = document.createElement("div");
  thumb.className = "vol-thumb";
  track.append(fill, thumb);
  pop.append(readout, track);
  volume.append(pop, volumeButton);
  let hideVolTimer = 0;
  volume.addEventListener("pointerenter", () => {
    window.clearTimeout(hideVolTimer);
    volume.classList.add("is-open");
  });
  volume.addEventListener("pointerleave", () => {
    window.clearTimeout(hideVolTimer);
    hideVolTimer = window.setTimeout(() => {
      volume.classList.remove("is-open");
    }, 220);
  });
  const snap = document.createElement("button");
  snap.type = "button";
  snap.className = "icon-btn";
  snap.textContent = "📷";
  snap.title = "Tirar print da live";
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
  bar.append(play, onAir, liveButton, volume, snap, pip, fullscreen);
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
  const initialVol = readPeerVolume(peerVolumes, stream.name);
  let savedVolume = initialVol.step || 100;
  let currentVolumeStep = initialVol.muted ? 0 : savedVolume;
  let boostGraph = null;
  function ensureBoostGraph() {
    if (boostGraph) {
      if (boostGraph.ctx?.state === "suspended") {
        boostGraph.ctx.resume().catch(() => {});
      }
      return boostGraph;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    try {
      const ctx = ensureSound() || new Ctx();
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      const source = ctx.createMediaElementSource(video);
      const gain = ctx.createGain();
      gain.gain.value = 1;
      source.connect(gain);
      gain.connect(ctx.destination);
      boostGraph = { ctx, source, gain };
      return boostGraph;
    } catch {
      return null;
    }
  }
  function syncGainNode(step) {
    if (step > 100) {
      const graph = ensureBoostGraph();
      if (graph) graph.gain.gain.value = step / 100;
    } else if (boostGraph) {
      boostGraph.gain.gain.value = 1;
    }
  }
  function volumeStep() {
    if (video.muted || video.volume === 0 || currentVolumeStep === 0) return 0;
    return clampVolumeStep(currentVolumeStep, MAX_VOLUME_STEP);
  }
  function paintSound() {
    const step = volumeStep();
    const ratio = Math.max(0, Math.min(100, (step / MAX_VOLUME_STEP) * 100));
    fill.style.height = `${ratio}%`;
    fill.classList.toggle("is-boost", step > 100);
    thumb.style.bottom = `${ratio}%`;
    readout.textContent = `${step}%`;
    track.setAttribute("aria-valuenow", String(step));
    volumeButton.textContent = step === 0 ? "🔇" : "🔊";
  }
  function applyVolume(percent, remember = true) {
    const step = clampVolumeStep(percent, MAX_VOLUME_STEP);
    currentVolumeStep = step;
    if (step > 0) savedVolume = step;
    const activeStep = step > 0 ? step : savedVolume;
    video.volume = Math.min(1, activeStep / 100);
    video.muted = step === 0;
    syncGainNode(step);
    if (remember) {
      peerVolumes = savePeerVolume(peerVolumes, stream.name, activeStep, step === 0);
      persistVolumeMap(peerVolumes);
    }
    paintSound();
  }
  function enforceSafeStartVolume() {
    if (savedVolume > MAX_SAVED_VOLUME_STEP) {
      savedVolume = capPlayStartVolume(savedVolume, MAX_SAVED_VOLUME_STEP);
    }
    if (currentVolumeStep > MAX_SAVED_VOLUME_STEP) {
      applyVolume(MAX_SAVED_VOLUME_STEP, true);
    }
  }
  function volumeFromPointer(event) {
    const rect = track.getBoundingClientRect();
    if (!rect.height) return;
    applyVolume((1 - (event.clientY - rect.top) / rect.height) * MAX_VOLUME_STEP);
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
    if (!peer.started) enforceSafeStartVolume();
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
    fetch("/api/watch", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ names: [stream.name] }),
    }).catch(() => {});
    paintTime();
  }
  function resumePlayback() {
    if (!peer.started) enforceSafeStartVolume();
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
    fetch("/api/watch", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ names: [stream.name] }),
    }).catch(() => {});
  }
  play.addEventListener("click", () => {
    if (!video.paused) {
      pauseStarted = performance.now();
      peer.userPaused = true;
      video.pause();
      fetch("/api/unwatch", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: stream.name }),
      }).catch(() => {});
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
    else if (event.key === "End") applyVolume(MAX_VOLUME_STEP);
    else return;
    event.preventDefault();
  });
  async function takeSnapshot() {
    if (!video.videoWidth || !video.videoHeight) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) return;
    try {
      if (navigator.clipboard?.write && window.ClipboardItem) {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      }
    } catch { /* também baixa o arquivo */ }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${stream.name}-${Date.now()}.png`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
    snap.textContent = "✓";
    window.setTimeout(() => { snap.textContent = "📷"; }, 1200);
  }
  snap.addEventListener("click", takeSnapshot);
  pip.addEventListener("click", () => {
    if (document.pictureInPictureElement === video) {
      document.exitPictureInPicture().catch(() => {});
      return;
    }
    if (!peer.started) resumePlayback();
    video.requestPictureInPicture().catch(() => {});
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
    poster, posterStamp, viewersBadge, switchNote,
    toggleMute() {
      if (video.muted || video.volume === 0) applyVolume(savedVolume || 100);
      else applyVolume(0);
    },
    togglePlay() {
      if (!video.paused) {
        pauseStarted = performance.now();
        peer.userPaused = true;
        video.pause();
        fetch("/api/unwatch", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: stream.name }),
        }).catch(() => {});
      } else {
        resumePlayback();
      }
    },
    toggleFullscreen() {
      if (document.fullscreenElement === el) document.exitFullscreen();
      else el.requestFullscreen();
    },
    goLive,
    takeSnapshot,
  };
  mediaLink = { peer, hls: null };
  el.addEventListener("pointerenter", () => { hoveredPeer = peer; });
  el.addEventListener("pointerleave", () => { if (hoveredPeer === peer) hoveredPeer = null; });
  close.addEventListener("click", () => {
    removeStream(stream.name);
    refreshGrid();
  });
  actions.append(title, viewersBadge, close);
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
  peer.resume = resumePlayback;
  peer.applyVolume = applyVolume;
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

function watchSnapshot(peer) {
  const video = peer.video;
  return {
    playing: Boolean(peer.started && !peer.userPaused && video && !video.paused),
    volume: video ? video.volume : 0,
    muted: Boolean(video && (video.muted || video.volume === 0)),
  };
}

function dropWatched(name, now) {
  const peer = peers.get(name);
  if (peer) returns = rememberReturn(returns, name, watchSnapshot(peer), now);
  removeStream(name);
}

function removeStream(name) {
  const peer = peers.get(name);
  if (!peer) return;
  peer.stop();
  peer.el.remove();
  peers.delete(name);
  fetch("/api/unwatch", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  }).catch(() => {});
  if (manualFocus === name) manualFocus = null;
  if (document.fullscreenElement === videoContainer && visibleCount() === 0) {
    document.exitFullscreen().catch(() => {});
  }
}

function stopAll() {
  returns = {};
  for (const name of [...peers.keys()]) removeStream(name);
  refreshGrid();
}

const OFFLINE_WAIT_MS = 90000;

function markSwitch(peer, kind = "screen") {
  if (!peer) return;
  if (peer.switchNote) {
    peer.switchNote.textContent = kind === "quality" ? "Trocando qualidade!" : "Trocando tela!";
  }
  if (peer.switching) return;
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
    const switchingKinds = data.switchingKinds || {};
    const liveNames = data.streams.map((stream) => stream.name).filter((name) => !stopped.has(name));
    const presentNames = [...new Set([...liveNames, ...switching])];
    const step = nextPresence(presence, presentNames, [...stopped], Date.now());
    const arrived = freshArrivals(step.enter, known);
    presence = { primed: step.primed, people: step.people };
    const now = Date.now();
    const readyAt = new Map(data.streams.map((stream) => [stream.name, Date.parse(stream.readyTime || "")]));
    const thumbAt = new Map(data.streams.map((stream) => [stream.name, Number(stream.thumbAt) || 0]));
    const viewersMap = new Map(data.streams.map((stream) => [stream.name, Number(stream.viewers) || 0]));
    for (const name of stopped) {
      catalog.delete(name);
      dropWatched(name, now);
    }
    const live = new Set(liveNames);
    const seen = new Set([...live, ...switching, ...catalog.keys()]);
    for (const name of seen) {
      if (stopped.has(name)) continue;
      const current = catalog.get(name) || { name, offline: false, offlineAt: 0, switching: false, viewers: 0 };
      const previousReady = current.readyAt;
      if (Number.isFinite(readyAt.get(name))) current.readyAt = readyAt.get(name);
      if (thumbAt.get(name)) current.thumbAt = thumbAt.get(name);
      const viewers = viewersMap.get(name) || 0;
      const phase = screenPhase(current, live.has(name), switching.has(name), now, OFFLINE_WAIT_MS, previousReady);
      if (phase.action === "drop") {
        catalog.delete(name);
        dropWatched(name, now);
        continue;
      }
      if (!catalog.has(name) && !live.has(name) && !switching.has(name)) continue;
      phase.entry.viewers = viewers;
      catalog.set(name, phase.entry);
      const peer = peers.get(name);
      if (Number.isFinite(phase.entry.readyAt) && peer) peer.readyAt = phase.entry.readyAt;
      if (peer?.viewersBadge) {
        peer.viewersBadge.textContent = viewers > 0 ? `👁 ${viewers}` : "";
        peer.viewersBadge.classList.toggle("hidden", viewers <= 0);
      }
      const posterStamp = Number(phase.entry.thumbAt) || 0;
      if (peer?.poster && posterStamp && peer.posterStamp !== posterStamp) {
        peer.posterStamp = posterStamp;
        peer.poster.src = `/api/thumb/${encodeURIComponent(name)}?t=${posterStamp}`;
      }
      if (phase.action === "switch") markSwitch(peer, switchingKinds[name]);
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
    returns = pruneReturns(returns, now);
    const resumed = new Set();
    for (const name of liveNames) {
      if (stopped.has(name) || peers.has(name)) continue;
      const claim = claimReturn(returns, name, now);
      returns = claim.memory;
      if (!claim.back) continue;
      resumed.add(name);
      addStream({ name });
      const peer = peers.get(name);
      if (!peer?.applyVolume) continue;
      peer.applyVolume(claim.back.muted ? 0 : claim.back.volume * 100);
      if (claim.back.playing && peer.resume) peer.resume();
    }
    const newcomers = arrived.filter((name) => !resumed.has(name));
    if (newcomers.length) {
      const theaterOn = theaterActive(theaterState);
      const fullscreenActive = Boolean(document.fullscreenElement);
      const railRect = railWrap ? railWrap.getBoundingClientRect() : null;
      const railCurrentlyVisible = Boolean(
        !theaterOn &&
        !fullscreenActive &&
        visualRailOpen(railState, now) &&
        (!railRect || railRect.width > 0)
      );
      if (shouldUseArrivalToast({ theaterOn, fullscreenActive, railVisible: railCurrentlyVisible })) {
        toastState = enqueueArrivalToasts(toastState, newcomers, now);
        paintArrivalToast();
      } else {
        noteRailEnter(now);
      }
      if (visibleCount() === 0) advanceHappyGif();
    }
    if (railHadNames && catalog.size === 0) noteRailEmpty();
    railHadNames = catalog.size > 0;
    refreshGrid();
    const watchingNames = [];
    for (const [name, peer] of peers) {
      if (!peer.hidden && peer.started && !peer.userPaused && peer.video && !peer.video.paused) {
        watchingNames.push(name);
      }
    }
    if (watchingNames.length) {
      fetch("/api/watch", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ names: watchingNames }),
      }).catch(() => {});
    }
    if (step.exit.length) queueChime("exit", step.exit);
    else queueChime("enter", newcomers);
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

function anyPlayingPeer() {
  for (const peer of peers.values()) {
    if (!peer.hidden && peer.started && !peer.userPaused && peer.video && !peer.video.paused) return true;
  }
  return false;
}

function activeKeyboardPeer() {
  if (hoveredPeer && !hoveredPeer.hidden) return hoveredPeer;
  if (manualFocus && peers.get(manualFocus) && !peers.get(manualFocus).hidden) return peers.get(manualFocus);
  const list = visiblePeers();
  return list.length === 1 ? list[0] : list[0] || null;
}

function paintTheater() {
  const on = theaterActive(theaterState);
  const peek = theaterHeaderVisible(theaterState);
  appView.classList.toggle("theater-mode", on);
  appView.classList.toggle("theater-peek", on && peek);
  if (theaterButton) {
    theaterButton.classList.toggle("is-on", on);
    theaterButton.setAttribute("aria-pressed", on ? "true" : "false");
  }
  if (on && !settingsPop.classList.contains("hidden") && !peek) {
    settingsPop.classList.add("hidden");
  }
}

if (theaterButton) {
  theaterButton.addEventListener("click", (event) => {
    event.stopPropagation();
    theaterState = theaterAfterToggle(theaterState, Date.now());
    paintTheater();
  });
}

document.addEventListener("mousemove", (event) => {
  if (appView.classList.contains("hidden")) return;
  const next = theaterAfterMove(theaterState, event.clientY, Date.now(), 58);
  if (
    next.manual !== theaterState.manual ||
    next.auto !== theaterState.auto ||
    next.peek !== theaterState.peek
  ) {
    theaterState = next;
    paintTheater();
  } else {
    theaterState = next;
  }
});

window.setInterval(() => {
  if (appView.classList.contains("hidden")) return;
  const next = theaterAfterTick(theaterState, anyPlayingPeer(), Date.now());
  if (next.auto !== theaterState.auto || next.manual !== theaterState.manual) {
    theaterState = next;
    paintTheater();
  } else {
    theaterState = next;
  }
}, 1000);

document.addEventListener("visibilitychange", () => {
  document.body.classList.toggle("tab-hidden", document.hidden);
});

document.addEventListener("keydown", (event) => {
  if (appView.classList.contains("hidden")) return;
  const tag = event.target instanceof Element ? event.target.tagName : "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (event.ctrlKey || event.altKey || event.metaKey) return;

  if (event.key === "Escape") {
    if (document.fullscreenElement) return;
    if (theaterActive(theaterState)) {
      theaterState = theaterAfterEscape(theaterState, Date.now());
      paintTheater();
      return;
    }
    if (visibleCount() <= 1 || !manualFocus) return;
    manualFocus = null;
    autoFocus = false;
    videoContainer.classList.remove("peer-focus-mode");
    delete videoContainer.dataset.spartanAutoFocus;
    clearFocusMarks();
    resizePeers();
    return;
  }

  if (event.key === "t" || event.key === "T") {
    event.preventDefault();
    theaterState = theaterAfterToggle(theaterState, Date.now());
    paintTheater();
    return;
  }

  const target = activeKeyboardPeer();
  if (!target) return;
  if (event.key === "m" || event.key === "M") {
    event.preventDefault();
    target.toggleMute?.();
  } else if (event.key === "f" || event.key === "F") {
    event.preventDefault();
    target.toggleFullscreen?.();
  } else if (event.key === " ") {
    if (event.target instanceof Element && event.target.closest("button")) return;
    event.preventDefault();
    target.togglePlay?.();
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    target.goLive?.();
  }
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
