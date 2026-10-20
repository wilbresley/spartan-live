export function createRailState(pinned = false) {
  return { pinned: Boolean(pinned), hovering: false };
}

export function visualRailOpen(state, { forceOpen = false } = {}) {
  if (state?.pinned) return true;
  if (forceOpen) return true;
  return Boolean(state?.hovering);
}

export function railAfterHover(state, hovering) {
  const nextHover = Boolean(hovering);
  if (Boolean(state?.hovering) === nextHover) return state || createRailState();
  return { pinned: Boolean(state?.pinned), hovering: nextHover };
}

export function railAfterPinToggle(state) {
  const current = state || createRailState();
  return { pinned: !current.pinned, hovering: Boolean(current.hovering) };
}

export function railAfterEmpty(state) {
  if (!state?.pinned && !state?.hovering) return state || createRailState();
  return { pinned: false, hovering: false };
}
