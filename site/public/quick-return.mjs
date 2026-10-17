export const QUICK_RETURN_MS = 60000;

export function rememberReturn(memory, name, info, now) {
  const volume = Number(info?.volume) || 0;
  return {
    ...(memory || {}),
    [name]: {
      at: now,
      playing: Boolean(info?.playing),
      volume,
      muted: Boolean(info?.muted) || volume === 0,
    },
  };
}

export function claimReturn(memory, name, now, waitMs = QUICK_RETURN_MS) {
  const item = memory?.[name];
  if (!item) return { memory: memory || {}, back: null };
  const next = { ...memory };
  delete next[name];
  if (now - item.at >= waitMs) return { memory: next, back: null };
  return { memory: next, back: item };
}

export function pruneReturns(memory, now, waitMs = QUICK_RETURN_MS) {
  const next = {};
  for (const [name, item] of Object.entries(memory || {})) {
    if (item && now - item.at < waitMs) next[name] = item;
  }
  return next;
}
