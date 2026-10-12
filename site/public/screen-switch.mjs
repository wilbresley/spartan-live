export function screenPhase(entry, live, switching, now, waitMs, previousReady) {
  const next = {
    name: entry.name,
    offline: Boolean(entry.offline),
    offlineAt: entry.offlineAt || 0,
    switching: Boolean(entry.switching),
    readyAt: entry.readyAt,
    thumbAt: entry.thumbAt || 0,
  };
  if (switching) {
    next.switching = true;
    next.offline = false;
    next.offlineAt = 0;
    return { entry: next, action: "switch" };
  }
  if (live) {
    const restarted = Number.isFinite(previousReady) && Number.isFinite(next.readyAt) && next.readyAt > previousReady + 1500;
    const revive = next.offline || next.switching || restarted;
    next.offline = false;
    next.offlineAt = 0;
    next.switching = false;
    return { entry: next, action: revive ? "revive" : "stay" };
  }
  if (next.switching) {
    next.switching = false;
    next.offline = true;
    next.offlineAt = now;
    return { entry: next, action: "offline" };
  }
  if (!next.offline) {
    next.offline = true;
    next.offlineAt = now;
  }
  if (now - next.offlineAt >= waitMs) return { entry: next, action: "drop" };
  return { entry: next, action: "offline" };
}
