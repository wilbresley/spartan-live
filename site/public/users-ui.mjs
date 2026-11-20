export const ROLE_ADMIN = "admin";
export const ROLE_USER = "user";
export const USER_NAME_RE = /^[a-z0-9_-]{2,24}$/;

export function normalizeName(raw) {
  return String(raw || "").trim().toLowerCase();
}

export function nameProblem(raw) {
  const name = normalizeName(raw);
  if (!name) return "Digite o nome da conta.";
  if (!USER_NAME_RE.test(name)) return "Use 2 a 24 letras sem acento, números, _ ou -.";
  return "";
}

export function roleLabel(role) {
  return role === ROLE_ADMIN ? "Admin" : "Usuário";
}

/** dd/mm do vencimento do convite (hora local, que é o que o admin enxerga). */
export function shortDate(exp) {
  const date = new Date(Number(exp));
  if (!Number.isFinite(date.getTime())) return "";
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${day}/${month}`;
}

/**
 * ready = senha definida e conta liberada; pending = senha provisória antiga;
 * invite = link de primeiro acesso ainda valendo; waiting = convite venceu.
 */
export function userState(user, now = Date.now()) {
  const record = user && typeof user === "object" ? user : {};
  const exp = Number(record.firstAccessExp) || 0;
  if (record.hasPassword) {
    return record.mustChange
      ? { kind: "pending", label: "troca de senha pendente" }
      : { kind: "ready", label: "senha definida" };
  }
  if (exp > now) return { kind: "invite", label: `convite até ${shortDate(exp)}` };
  return { kind: "waiting", label: "convite vencido" };
}

export function sortUsers(users) {
  const list = Array.isArray(users) ? users.filter((row) => row && typeof row.user === "string") : [];
  return [...list].sort((a, b) => {
    const aAdmin = a.role === ROLE_ADMIN ? 0 : 1;
    const bAdmin = b.role === ROLE_ADMIN ? 0 : 1;
    if (aAdmin !== bAdmin) return aAdmin - bAdmin;
    return a.user.localeCompare(b.user, "pt-BR");
  });
}

/** Link absoluto do primeiro acesso; vazio quando o caminho não é /p/<token>. */
export function accountLink(origin, path) {
  const raw = String(path || "");
  if (!/^\/p\/[A-Za-z0-9_-]{16,64}$/.test(raw)) return "";
  try {
    return new URL(raw, String(origin || "http://localhost")).href;
  } catch {
    return "";
  }
}

/** Nome como a pessoa lê na mensagem: primeira letra maiúscula, o login segue minúsculo. */
export function displayName(raw) {
  const name = normalizeName(raw);
  if (!name) return "";
  return name[0].toUpperCase() + name.slice(1);
}

export const MESSAGE_INVITE = "invite";
export const MESSAGE_RESET = "reset";
export const MESSAGE_SHORT = "short";

/**
 * Texto pronto para mandar por WhatsApp, com o link dentro.
 * invite = conta nova (primeiro acesso); reset = link novo de quem perdeu a senha;
 * short = duas linhas, para o terminal ou para quem já conhece o site.
 * Sem site, as linhas que repetem o endereço saem fora; sem nome ou link, "".
 */
export function accountMessage(kind, { name = "", link = "", site = "" } = {}) {
  const who = displayName(name);
  const login = normalizeName(name);
  const url = String(link || "").trim();
  const base = String(site || "").trim().replace(/\/+$/, "");
  if (!who || !url) return "";

  if (kind === MESSAGE_SHORT) {
    const tail = base ? ` Site: ${base}` : "";
    return `${who}, seu acesso do Spartan Live: ${url}\n` +
      `Login: ${login} — a senha você define no link. Vale 7 dias, uma vez só.${tail}`;
  }

  if (kind === MESSAGE_RESET) {
    return [
      `Oi, ${who}. Gerei uma senha nova pra sua conta do *Spartan Live*.`,
      "A senha antiga parou de valer agora, e as sessões abertas caíram. Escolha a nova no link abaixo — vale *7 dias* e serve *uma vez*.",
      `👉 ${url}`,
      base ? `*Login:* ${login}\nSite: ${base}` : `*Login:* ${login}`,
    ].join("\n\n");
  }

  return [
    `Oi, ${who}! 👋`,
    "Criei seu acesso ao *Spartan Live*, a página onde a gente transmite a tela do jogo ao vivo — você abre no navegador e assiste, sem instalar nada.",
    `*Login:* ${login}\n*Senha:* você escolhe agora, no link abaixo (mínimo 8 caracteres).`,
    `👉 ${url}`,
    base
      ? "O link vale *7 dias* e só abre *uma vez*. Se vencer, me pede outro.\n" +
        `Depois de salvar a senha, guarda o endereço do site pra entrar direto: ${base}`
      : "O link vale *7 dias* e só abre *uma vez*. Se vencer, me pede outro.",
    "Se você também vai transmitir, o programa é o SpartanLive.exe — dá pra baixar dentro do site, em Ajustes.",
  ].join("\n\n");
}

/** Motivo para não excluir a conta ("" = pode excluir). Espelha as travas do servidor. */
export function deleteBlocked(user, me, users) {
  const name = normalizeName(user?.user);
  if (!name) return "Conta inválida.";
  if (name === normalizeName(me)) return "Para excluir a própria conta, use outra conta admin.";
  const list = Array.isArray(users) ? users : [];
  const admins = list.filter((row) => row?.role === ROLE_ADMIN).length;
  if (user?.role === ROLE_ADMIN && admins <= 1) return "O último admin não pode ser excluído.";
  return "";
}
