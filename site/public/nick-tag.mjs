export const NICK_MIN = 2;
export const NICK_MAX = 24;
export const NICK_KEY = "spartan-live-display-nick";

// Só ASCII, igual ao programa: "josé" é recusado (escreva "jose"). O acento quebrava
// o nome do caminho da live e o crachá aparecia cortado.
const NICK_CHAR = /^[A-Za-z0-9 _-]$/;

export function cleanNick(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length < NICK_MIN || text.length > NICK_MAX) return "";
  for (const ch of text) {
    if (!NICK_CHAR.test(ch)) return "";
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
