export const GUEST_HOURS = [3, 6, 12, 24];
export const PERMANENT_HOLD_MS = 10_000;
export const PERMANENT_SESSION_MS = 10 * 365 * 24 * 60 * 60 * 1000;

export function guestHours(value) {
  const hours = Number(value);
  return GUEST_HOURS.includes(hours) ? hours : 0;
}

export function createGuest(hours, now, id) {
  const span = guestHours(hours);
  const token = String(id || "");
  if (!span || !/^[\w-]{16,64}$/.test(token)) return null;
  return { id: token, hours: span, exp: Number(now) + span * 60 * 60 * 1000, kind: "temporary" };
}

export function createPermanentGuest(id, now = Date.now()) {
  const token = String(id || "");
  if (!/^[\w-]{16,64}$/.test(token)) return null;
  return { id: token, kind: "permanent", exp: Number(now) + PERMANENT_SESSION_MS };
}

export function guestActive(record, now = Date.now()) {
  if (!record || typeof record.id !== "string" || typeof record.exp !== "number") return null;
  if (record.kind === "permanent") return record;
  if (record.exp <= now) return null;
  return record;
}

export function normalizeGuestStore(raw, now = Date.now()) {
  if (!raw || typeof raw !== "object") return { temporary: null, permanent: null };
  if (raw.temporary !== undefined || raw.permanent !== undefined) {
    return {
      temporary: guestActive(raw.temporary, now),
      permanent: raw.permanent && typeof raw.permanent.id === "string"
        ? { id: raw.permanent.id, kind: "permanent", exp: Number(raw.permanent.exp) || (now + PERMANENT_SESSION_MS) }
        : null,
    };
  }
  if (typeof raw.id === "string" && typeof raw.exp === "number") {
    return { temporary: guestActive(raw, now), permanent: null };
  }
  return { temporary: null, permanent: null };
}

export function findGuestInvite(store, id, now = Date.now()) {
  const book = normalizeGuestStore(store, now);
  if (book.temporary?.id === id) return { invite: book.temporary, kind: "temporary" };
  if (book.permanent?.id === id) return { invite: book.permanent, kind: "permanent" };
  return null;
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

export function guestEndMessage(reason) {
  if (reason === "revoked") return "Esse convite foi revogado. O link não está mais disponível.";
  if (reason === "expired") return "O tempo desse convite acabou. O link não está mais disponível.";
  return "Esse link não existe mais.";
}
