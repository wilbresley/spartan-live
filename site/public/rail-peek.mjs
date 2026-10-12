export const RAIL_PEEK_MS = 10000;

export function visualRailOpen(state, now) {
  if (state.storedOpen || state.held) return true;
  return (state.peekUntil || 0) > now;
}

export function peekSecondsLeft(state, now) {
  const left = (state.peekUntil || 0) - now;
  if (left <= 0) return 0;
  return Math.ceil(left / 1000);
}

export function railAfterEnter(state, now, waitMs = RAIL_PEEK_MS) {
  const next = { ...state };
  if ((next.peekUntil || 0) > now) {
    next.peekUntil = now + waitMs;
    return next;
  }
  if (visualRailOpen(next, now)) return next;
  next.peekUntil = now + waitMs;
  return next;
}

export function railAfterInteract(state, now) {
  if ((state.peekUntil || 0) <= now) return state;
  return { ...state, peekUntil: 0, held: true };
}

export function railAfterToggle(state, now) {
  const open = visualRailOpen(state, now);
  return { storedOpen: !open, held: false, peekUntil: 0 };
}

export function railAfterTick(state, now) {
  if (!state.peekUntil || state.peekUntil > now) return state;
  return { ...state, peekUntil: 0 };
}

export function railAfterEmpty(state) {
  if (!state.storedOpen && !state.held && !(state.peekUntil > 0)) return state;
  return { storedOpen: false, held: false, peekUntil: 0 };
}
