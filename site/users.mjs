import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hashPassword, passwordStamp, verifyPassword } from "./password.mjs";

// Apelido de tela e nome de usuário são a mesma coisa: quem transmite entra com o
// próprio nome e a grade mostra esse nome. Por isso o formato é o mesmo do antigo
// apelido ASCII que o programa e o site já exigem.
export const USER_RE = /^[a-z0-9_-]{2,24}$/;
export const ROLE_ADMIN = "admin";
export const ROLE_USER = "user";
export const FIRST_ACCESS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const FIRST_ACCESS_PAGE = "/p/";
export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 128;
// Senhas que qualquer um tenta primeiro. A lista é curta de propósito: ela pega o
// óbvio, não substitui uma senha boa.
const BLOCKED = new Set([
  "spartanadmin",
  "mudar@123",
  "mudar123",
  "senha123",
  "password",
  "12345678",
  "123456789",
  "admin123",
  "qwerty123",
]);

export function normalizeUserName(raw) {
  return String(raw || "").trim().toLowerCase();
}

export function validUserName(name) {
  return USER_RE.test(normalizeUserName(name));
}

export function emptyStore() {
  return { version: 1, users: [] };
}

function looksLikeHash(record) {
  if (!record || typeof record !== "object") return false;
  if (typeof record.salt !== "string" || typeof record.hash !== "string") return false;
  return Buffer.from(record.salt, "base64url").length >= 8
    && Buffer.from(record.hash, "base64url").length >= 16;
}

export function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("base64url");
}

export function newToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function firstAccessPath(token) {
  return `${FIRST_ACCESS_PAGE}${token}`;
}

function tokenMatches(user, token) {
  const stored = user?.first?.hash;
  const given = String(token || "");
  if (typeof stored !== "string" || !stored || given.length < 16) return false;
  const a = Buffer.from(stored);
  const b = Buffer.from(hashToken(given));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function findUser(store, name) {
  const wanted = normalizeUserName(name);
  if (!wanted || !Array.isArray(store?.users)) return null;
  return store.users.find((item) => item?.user === wanted) || null;
}

export function adminCount(store) {
  return (store?.users || []).filter((item) => item?.role === ROLE_ADMIN).length;
}

// O que pode sair para a tela: nunca salt, hash ou hash do token.
export function publicUser(user, now = Date.now()) {
  const first = user?.first;
  const usable = Boolean(first && typeof first.exp === "number" && first.exp > now && !user?.hash);
  return {
    user: user?.user || "",
    role: user?.role === ROLE_ADMIN ? ROLE_ADMIN : ROLE_USER,
    hasPassword: Boolean(user?.hash),
    mustChange: Boolean(user?.mustChange),
    createdAt: Number(user?.createdAt || 0),
    lastLoginAt: Number(user?.lastLoginAt || 0),
    firstAccessExp: usable ? Number(first.exp) : 0,
    firstAccessUsable: usable,
  };
}

export function checkPassword(userName, plain) {
  const text = String(plain || "");
  if (text.length < MIN_PASSWORD) return `A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.`;
  if (text.length > MAX_PASSWORD) return `A senha não pode passar de ${MAX_PASSWORD} caracteres.`;
  if (text.toLowerCase() === normalizeUserName(userName)) return "A senha não pode ser o seu nome de usuário.";
  if (BLOCKED.has(text.toLowerCase())) return "Essa senha é fácil de adivinhar. Escolha outra.";
  return "";
}

export function setUserPassword(store, name, plain, now = Date.now()) {
  const user = findUser(store, name);
  if (!user) return { store, error: "usuário não encontrado", status: 404 };
  const problem = checkPassword(user.user, plain);
  if (problem) return { store, error: problem, status: 400 };
  Object.assign(user, hashPassword(plain), {
    mustChange: false,
    passwordAt: now,
    first: null,
  });
  return { store, user };
}

export function verifyUserLogin(store, name, plain, now = Date.now()) {
  const user = findUser(store, name);
  if (!user) return { ok: false, reason: "user" };
  // Conta criada e link não usado: não existe senha para conferir. A resposta para
  // quem tenta entrar continua sendo a mesma de senha errada.
  if (!looksLikeHash(user)) return { ok: false, reason: "nopass" };
  if (!verifyPassword(String(plain || ""), user)) return { ok: false, reason: "pass" };
  user.lastLoginAt = now;
  return { ok: true, user };
}

// Credencial de transmissão: é o mesmo usuário e a mesma senha do site.
export function publishAllowed(store, name, plain) {
  const user = findUser(store, name);
  if (!user || !looksLikeHash(user) || user.mustChange) return false;
  return verifyPassword(String(plain || ""), user);
}

export function userStamp(user) {
  return passwordStamp(user);
}

function issueToken(user, now, ttl) {
  const token = newToken();
  user.first = { hash: hashToken(token), exp: now + ttl, at: now };
  return token;
}

export function createUser(store, name, { role = ROLE_USER, now = Date.now(), ttl = FIRST_ACCESS_TTL_MS } = {}) {
  const user = normalizeUserName(name);
  if (!validUserName(user)) {
    return { store, error: "O nome precisa ter de 2 a 24 letras, números, _ ou -", status: 400 };
  }
  if (findUser(store, user)) return { store, error: "Já existe um usuário com esse nome.", status: 409 };
  const record = {
    user,
    role: role === ROLE_ADMIN ? ROLE_ADMIN : ROLE_USER,
    mustChange: false,
    createdAt: now,
    passwordAt: 0,
    lastLoginAt: 0,
  };
  const token = issueToken(record, now, ttl);
  store.users.push(record);
  return { store, user: record, token };
}

// Redefinir = apagar a senha e emitir um link novo. A senha antiga para de valer na
// hora (sessões caem pela marca e o publish é recusado no próximo pedido).
export function resetUserPassword(store, name, { now = Date.now(), ttl = FIRST_ACCESS_TTL_MS } = {}) {
  const user = findUser(store, name);
  if (!user) return { store, error: "usuário não encontrado", status: 404 };
  delete user.salt;
  delete user.hash;
  delete user.n;
  delete user.r;
  delete user.p;
  user.mustChange = false;
  user.passwordAt = 0;
  const token = issueToken(user, now, ttl);
  return { store, user, token };
}

export function deleteUser(store, name) {
  const user = findUser(store, name);
  if (!user) return { store, error: "usuário não encontrado", status: 404 };
  if (user.role === ROLE_ADMIN && adminCount(store) <= 1) {
    return { store, error: "O último admin não pode ser excluído.", status: 409 };
  }
  store.users = store.users.filter((item) => item !== user);
  return { store, removed: user };
}

export function findFirstAccess(store, token, now = Date.now()) {
  if (!Array.isArray(store?.users)) return null;
  for (const user of store.users) {
    if (!tokenMatches(user, token)) continue;
    if (!user.first || typeof user.first.exp !== "number" || user.first.exp <= now) return null;
    return user;
  }
  return null;
}

export function redeemFirstAccess(store, token, plain, now = Date.now()) {
  const user = findFirstAccess(store, token, now);
  if (!user) return { store, error: "Esse link já foi usado ou venceu.", status: 410 };
  const problem = checkPassword(user.user, plain);
  if (problem) return { store, error: problem, status: 400 };
  Object.assign(user, hashPassword(plain), {
    mustChange: false,
    passwordAt: now,
    first: null,
    lastLoginAt: now,
  });
  return { store, user };
}

function normalizeRecord(raw, fallbackNow) {
  if (!raw || typeof raw !== "object") return null;
  const user = normalizeUserName(raw.user);
  if (!validUserName(user)) return null;
  const record = {
    user,
    role: raw.role === ROLE_ADMIN ? ROLE_ADMIN : ROLE_USER,
    mustChange: Boolean(raw.mustChange),
    createdAt: Number(raw.createdAt) || fallbackNow,
    passwordAt: Number(raw.passwordAt) || 0,
    lastLoginAt: Number(raw.lastLoginAt) || 0,
  };
  if (looksLikeHash(raw)) {
    record.salt = raw.salt;
    record.hash = raw.hash;
    record.n = Number(raw.n) || 16384;
    record.r = Number(raw.r) || 8;
    record.p = Number(raw.p) || 1;
  }
  if (raw.first && typeof raw.first.hash === "string" && typeof raw.first.exp === "number") {
    record.first = { hash: raw.first.hash, exp: raw.first.exp, at: Number(raw.first.at) || 0 };
  }
  return record;
}

export function normalizeStore(raw, now = Date.now()) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.users)) return null;
  const users = [];
  const seen = new Set();
  for (const item of raw.users) {
    const record = normalizeRecord(item, now);
    if (!record || seen.has(record.user)) continue;
    seen.add(record.user);
    users.push(record);
  }
  if (users.length === 0) return null;
  return { version: 1, users };
}

function writeStore(file, store) {
  const clean = {
    version: 1,
    users: store.users.map((user) => ({ ...user })),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(clean), { mode: 0o600 });
  fs.renameSync(temp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* o volume do Windows não aceita esse modo */
  }
  return clean;
}

export function saveUsers(file, store) {
  const clean = writeStore(file, store);
  store.users = clean.users;
  return store;
}

// Guarda o arquivo ruim de lado antes de recriar, igual ao password.json.
function quarantine(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${file}.corrupt-${stamp}`;
  try {
    fs.renameSync(file, backup);
    return backup;
  } catch {
    return "";
  }
}

function readLegacy(legacyFile, now) {
  if (!legacyFile) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(legacyFile, "utf8"));
    if (!looksLikeHash(raw)) return null;
    return {
      user: normalizeUserName(raw.user) || "",
      salt: raw.salt,
      hash: raw.hash,
      n: Number(raw.n) || 16384,
      r: Number(raw.r) || 8,
      p: Number(raw.p) || 1,
      mustChange: Boolean(raw.mustChange),
      now,
    };
  } catch {
    return null;
  }
}

// Primeiro admin do servidor. Se já existe um password.json (instalação antiga), ele
// herda a senha atual para ninguém ficar trancado para fora no deploy. Se é instalação
// nova, nasce com senha aleatória que aparece uma vez e a troca obrigatória.
function bootstrapAdmin(adminUser, legacy) {
  const user = {
    user: adminUser,
    role: ROLE_ADMIN,
    mustChange: true,
    createdAt: legacy?.now || Date.now(),
    passwordAt: legacy?.now || 0,
    lastLoginAt: 0,
  };
  if (legacy) {
    user.salt = legacy.salt;
    user.hash = legacy.hash;
    user.n = legacy.n;
    user.r = legacy.r;
    user.p = legacy.p;
    user.mustChange = legacy.mustChange;
    return { user, initialPassword: "" };
  }
  const initialPassword = crypto.randomBytes(9).toString("hex");
  Object.assign(user, hashPassword(initialPassword));
  return { user, initialPassword };
}

/**
 * Lê (ou cria) o users.json. Devolve também a senha inicial do admin quando ela
 * acabou de ser gerada — quem chama deve mostrar uma vez e não guardar.
 */
export function loadUsers(file, { adminUser = "spartan", legacyFile = "", now = Date.now() } = {}) {
  const admin = validUserName(adminUser) ? normalizeUserName(adminUser) : "spartan";
  if (fs.existsSync(file)) {
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      raw = null;
    }
    const store = normalizeStore(raw, now);
    if (store) {
      // Sem admin ninguém administra: promove o mais antigo em vez de apagar a lista.
      if (adminCount(store) === 0) {
        const first = [...store.users].sort((a, b) => a.createdAt - b.createdAt)[0];
        if (first) first.role = ROLE_ADMIN;
      }
      return { store, initialPassword: "" };
    }
    const backup = quarantine(file);
    console.warn(
      `users.json invalido${backup ? ` (guardado em ${path.basename(backup)})` : ""}; recriando.`,
    );
  }
  const legacy = readLegacy(legacyFile, now);
  const { user, initialPassword } = bootstrapAdmin(admin, legacy);
  const store = { version: 1, users: [user] };
  saveUsers(file, store);
  return { store, initialPassword };
}

