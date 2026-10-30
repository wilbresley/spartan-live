export const THEATER_IDLE_MS = 30000;
export const VIEWER_TTL_MS = 4500;

export function createTheaterState() {
  return {
    manual: false,
    auto: false,
    peek: false,
    idleSince: 0,
  };
}

export function theaterAfterToggle(state, now = 0) {
  const active = Boolean(state?.manual || state?.auto);
  if (active) {
    return { manual: false, auto: false, peek: false, idleSince: now };
  }
  return { manual: true, auto: false, peek: false, idleSince: now };
}

export function theaterAfterEscape(state, now = 0) {
  return { manual: false, auto: false, peek: false, idleSince: now };
}

export function theaterAfterMove(state, y, now, headerBottom = 56) {
  const manual = Boolean(state?.manual);
  if (manual) {
    const peek = Number(y) <= headerBottom;
    return { manual: true, auto: false, peek, idleSince: now };
  }
  return { manual: false, auto: false, peek: false, idleSince: now };
}

export function theaterAfterTick(state, hasPlaying, now, idleMs = THEATER_IDLE_MS) {
  if (!hasPlaying) {
    if (state?.manual) return { ...state, auto: false };
    return { manual: false, auto: false, peek: false, idleSince: now };
  }
  if (state?.manual) return state;
  const since = state?.idleSince || now;
  const auto = now - since >= idleMs;
  return {
    manual: false,
    auto,
    peek: false,
    idleSince: since,
  };
}

export function theaterActive(state) {
  return Boolean(state?.manual || state?.auto);
}

export function theaterHeaderVisible(state) {
  if (!theaterActive(state)) return true;
  if (state?.manual && state?.peek) return true;
  return false;
}

export function theaterHoldPeek(state, hold) {
  if (!hold || !theaterActive(state)) return state || createTheaterState();
  if (state.peek) return state;
  return { ...state, peek: true };
}

export const HEADER_COMPACT_PX = 720;
export const FULLSCREEN_EXIT_MS = 1400;

export function headerShouldCompact(width, limit = HEADER_COMPACT_PX) {
  return Number(width) <= limit;
}

export function pointerHasHover(hover = "", pointer = "") {
  return hover === "hover" && pointer === "fine";
}

export function theaterAutoIdleMs(hoverOk, railPinned = false) {
  if (!hoverOk || railPinned) return Number.POSITIVE_INFINITY;
  return THEATER_IDLE_MS;
}

export function fullscreenExitLingerMs(hoverOk) {
  return hoverOk ? FULLSCREEN_EXIT_MS : 0;
}

export function volumeTapAction(hoverOk, open) {
  if (hoverOk) return { open: Boolean(open), mute: true };
  return { open: !open, mute: false };
}

export const MAX_VOLUME_STEP = 200;
export const MAX_SAVED_VOLUME_STEP = 100;
export const TOAST_DURATION_MS = 5000;

export function clampVolumeStep(percent, maxStep = MAX_VOLUME_STEP) {
  const num = Number(percent);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(maxStep, Math.round(num / 5) * 5));
}

export function capPlayStartVolume(step, maxSafe = MAX_SAVED_VOLUME_STEP) {
  const clean = clampVolumeStep(step, MAX_VOLUME_STEP);
  if (clean <= 0) return maxSafe;
  return Math.min(maxSafe, clean);
}

export function savePeerVolume(map, name, step, muted) {
  if (!name) return map || {};
  const raw = clampVolumeStep(step, MAX_VOLUME_STEP);
  const safeStep = Math.min(MAX_SAVED_VOLUME_STEP, raw);
  const fallback = Math.min(MAX_SAVED_VOLUME_STEP, Number(map?.[name]?.step) || MAX_SAVED_VOLUME_STEP);
  return {
    ...(map || {}),
    [name]: {
      step: safeStep > 0 ? safeStep : fallback,
      muted: Boolean(muted) || raw === 0,
    },
  };
}

export function readPeerVolume(map, name) {
  const entry = map?.[name];
  if (!entry) return { step: 100, muted: true };
  const step = Math.max(5, Math.min(MAX_SAVED_VOLUME_STEP, Math.round((Number(entry.step) || 100) / 5) * 5));
  return {
    step,
    muted: entry.muted !== false,
  };
}

export function shouldUseArrivalToast({ theaterOn = false, fullscreenActive = false, railVisible = true } = {}) {
  if (fullscreenActive || theaterOn) return true;
  return !railVisible;
}

export function createToastQueue() {
  return {
    active: null,
    queue: [],
  };
}

export function enqueueArrivalToasts(state, names, now = 0, durationMs = TOAST_DURATION_MS) {
  const current = {
    active: state?.active ? { ...state.active } : null,
    queue: Array.isArray(state?.queue) ? [...state.queue] : [],
  };
  for (const raw of names || []) {
    const name = String(raw || "").trim();
    if (!name) continue;
    if (current.active?.name === name || current.queue.includes(name)) continue;
    current.queue.push(name);
  }
  if (!current.active && current.queue.length > 0) {
    const nextName = current.queue.shift();
    current.active = { name: nextName, until: now + durationMs };
  }
  return current;
}

export function tickToastQueue(state, now = 0, durationMs = TOAST_DURATION_MS) {
  if (!state?.active) {
    if (!state?.queue?.length) return state || createToastQueue();
    return enqueueArrivalToasts(state, [], now, durationMs);
  }
  if (state.active.paused) return state;
  if (now < state.active.until) return state;
  const queue = Array.isArray(state.queue) ? [...state.queue] : [];
  if (queue.length === 0) {
    return { active: null, queue: [] };
  }
  const nextName = queue.shift();
  return {
    active: { name: nextName, until: now + durationMs },
    queue,
  };
}

export function dismissActiveToast(state, now = 0, durationMs = TOAST_DURATION_MS) {
  const queue = Array.isArray(state?.queue) ? [...state.queue] : [];
  if (queue.length === 0) {
    return { active: null, queue: [] };
  }
  const nextName = queue.shift();
  return {
    active: { name: nextName, until: now + durationMs },
    queue,
  };
}

export function holdToast(state, holding, now = 0) {
  if (!state?.active) return state || createToastQueue();
  const active = state.active;
  if (holding) {
    if (active.paused) return state;
    return {
      active: { ...active, paused: true, remaining: Math.max(0, active.until - now) },
      queue: state.queue,
    };
  }
  if (!active.paused) return state;
  return {
    active: { name: active.name, until: now + Math.max(0, Number(active.remaining) || 0) },
    queue: state.queue,
  };
}

export function touchViewer(book, name, viewerId, now = Date.now()) {
  if (!name || !viewerId) return;
  let room = book.get(name);
  if (!room) {
    room = new Map();
    book.set(name, room);
  }
  room.set(viewerId, now);
}

export function dropViewer(book, name, viewerId) {
  if (!name || !viewerId) return;
  const room = book.get(name);
  if (!room) return;
  room.delete(viewerId);
  if (room.size === 0) book.delete(name);
}

export function audienceMarks(viewers, guests, permanent = 0) {
  const account = Math.max(0, Number(viewers) || 0);
  const temporary = Math.max(0, Number(guests) || 0);
  const forever = Math.max(0, Number(permanent) || 0);
  const parts = [];
  if (account > 0) parts.push(`👁 ${account}`);
  if (temporary > 0) parts.push(`⏳ ${temporary}`);
  if (forever > 0) parts.push(`∞ ${forever}`);
  return parts.join("  ");
}

export function countViewers(book, name, now = Date.now(), ttlMs = VIEWER_TTL_MS) {
  const room = book.get(name);
  if (!room) return 0;
  for (const [id, seenAt] of room.entries()) {
    if (now - seenAt > ttlMs) room.delete(id);
  }
  if (room.size === 0) {
    book.delete(name);
    return 0;
  }
  return room.size;
}

export function touchRoster(book, name, viewerId, nick, kind, now = Date.now()) {
  if (!name || !viewerId || !nick) return;
  let room = book.get(name);
  if (!room) {
    room = new Map();
    book.set(name, room);
  }
  room.set(viewerId, { nick, kind: kind || "owner", at: now });
}

export function listRoster(book, name, now = Date.now(), ttlMs = VIEWER_TTL_MS) {
  const room = book.get(name);
  if (!room) return [];
  const people = [];
  for (const [id, row] of room.entries()) {
    const at = Number(row?.at) || 0;
    if (now - at > ttlMs) {
      room.delete(id);
      continue;
    }
    const nick = String(row?.nick || "").trim();
    if (!nick) {
      room.delete(id);
      continue;
    }
    people.push({ nick, kind: row.kind || "owner" });
  }
  if (room.size === 0) book.delete(name);
  people.sort((a, b) => a.nick.localeCompare(b.nick, "pt-BR"));
  return people;
}

export const GIF_CACHE = "v5";
export const SAD_GIFS = Array.from({ length: 12 }, (_, idx) => `/gifs/sad-${idx + 1}.gif?${GIF_CACHE}`);
export const HAPPY_GIFS = Array.from({ length: 12 }, (_, idx) => `/gifs/happy-${idx + 1}.gif?${GIF_CACHE}`);

export function nextCycleIndex(current, total) {
  const size = Math.max(1, Number(total) || 1);
  const idx = Number.isInteger(current) && current >= 0 ? current : -1;
  return (idx + 1) % size;
}

export function pickNextGif(list, currentIndex) {
  const items = Array.isArray(list) && list.length ? list : [""];
  const nextIndex = nextCycleIndex(currentIndex, items.length);
  return { index: nextIndex, src: items[nextIndex] };
}

export function pairStacks(count, viewWidth, screenWidth) {
  if (Number(count) !== 2) return false;
  const view = Number(viewWidth);
  const screen = Number(screenWidth);
  if (!Number.isFinite(view) || !Number.isFinite(screen) || screen <= 0) return false;
  return view < screen * 0.5;
}
