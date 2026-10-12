export const REWIND_SEC = 120;
export const LIVE_GAP_SEC = 10;
export const LIVE_LED_SEC = 7;
export const PAUSE_RESET_SEC = 300;
export const SNAP_BEHIND_SEC = 90;

export function playbackGlitch(highTime, current, slack = 2.5) {
  return Number.isFinite(highTime) && Number.isFinite(current) && highTime - current > slack;
}

export function shouldSnapToLive(behind, limit = SNAP_BEHIND_SEC) {
  return Number.isFinite(behind) && behind > limit;
}

export function rewindWindow(start, end, limit = REWIND_SEC) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || !(end > start)) return null;
  return { start: Math.max(start, end - limit), end };
}

export function formatOnAir(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  if (hours > 0) return `${hours}:${mm}:${ss}`;
  return `${minutes}:${ss}`;
}

export function scrubRatio(current, start, end) {
  const span = end - start;
  if (!(span > 0) || !Number.isFinite(current)) return 1;
  return Math.min(1, Math.max(0, (current - start) / span));
}

export function scrubTarget(ratio, start, end) {
  const span = Math.max(0, end - start);
  const clamped = Math.min(1, Math.max(0, Number(ratio) || 0));
  return start + clamped * span;
}

export function isFollowingLive(current, edge, gap = LIVE_GAP_SEC) {
  if (!Number.isFinite(current) || !Number.isFinite(edge)) return false;
  return edge - current <= gap;
}

export function liveLedSynced(current, edge, limit = LIVE_LED_SEC) {
  return isFollowingLive(current, edge, limit);
}

export function resumeTime(pausedTime, heldSec, bounds) {
  if (!bounds) return pausedTime;
  if (heldSec >= PAUSE_RESET_SEC || pausedTime < bounds.start) return bounds.start;
  return Math.min(Math.max(pausedTime, bounds.start), bounds.end);
}

