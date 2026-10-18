export const GUEST_HOURS = [3, 6, 12, 24];

export function guestHours(value) {
  const hours = Number(value);
  return GUEST_HOURS.includes(hours) ? hours : 0;
}

export function createGuest(hours, now, id) {
  const span = guestHours(hours);
  const token = String(id || "");
  if (!span || !/^[\w-]{16,64}$/.test(token)) return null;
  return { id: token, hours: span, exp: Number(now) + span * 60 * 60 * 1000 };
}

export function guestActive(record, now = Date.now()) {
  if (!record || typeof record.id !== "string" || typeof record.exp !== "number") return null;
  if (record.exp <= now) return null;
  return record;
}

export function guestRemainLabel(exp, now = Date.now()) {
  const left = Math.max(0, Math.ceil((Number(exp) - now) / 1000));
  const hours = Math.floor(left / 3600);
  const minutes = Math.floor((left % 3600) / 60);
  const seconds = left % 60;
  if (hours > 0) return `${hours}h ${minutes}min`;
  if (minutes > 0) return `${minutes}min ${seconds}s`;
  return `${seconds}s`;
}
