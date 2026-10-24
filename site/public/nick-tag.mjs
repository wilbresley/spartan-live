export const NICK_MIN = 2;
export const NICK_MAX = 24;
export const NICK_KEY = "spartan-live-display-nick";

export function cleanNick(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length < NICK_MIN || text.length > NICK_MAX) return "";
  for (const ch of text) {
    if (!/[\p{L}\p{N} _-]/u.test(ch)) return "";
  }
  return text;
}

export function kindMark(kind) {
  if (kind === "permanent") return "∞";
  if (kind === "temporary") return "⏳";
  if (kind === "owner") return "👁";
  return "";
}

export function sortPeople(people) {
  return [...(people || [])]
    .filter((row) => row && cleanNick(row.nick))
    .sort((a, b) => cleanNick(a.nick).localeCompare(cleanNick(b.nick), "pt-BR"));
}
