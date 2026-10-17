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

export function savePeerVolume(map, name, step, muted) {
  if (!name) return map || {};
  const clean = Math.max(0, Math.min(100, Math.round(Number(step) / 5) * 5));
  return {
    ...(map || {}),
    [name]: {
      step: clean > 0 ? clean : Number(map?.[name]?.step) || 100,
      muted: Boolean(muted) || clean === 0,
    },
  };
}

export function readPeerVolume(map, name) {
  const entry = map?.[name];
  if (!entry) return { step: 100, muted: true };
  const step = Math.max(5, Math.min(100, Math.round((Number(entry.step) || 100) / 5) * 5));
  return {
    step,
    muted: entry.muted !== false,
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

export const SAD_GIFS = Array.from({ length: 12 }, (_, idx) => `/gifs/sad-${idx + 1}.gif`);
export const HAPPY_GIFS = Array.from({ length: 12 }, (_, idx) => `/gifs/happy-${idx + 1}.gif`);

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
