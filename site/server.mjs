import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import {
  FIRST_ACCESS_PAGE,
  ROLE_ADMIN,
  ROLE_USER,
  checkPassword,
  createUser,
  deleteUser,
  findFirstAccess,
  findUser,
  firstAccessPath,
  loadUsers,
  normalizeUserName,
  publicUser,
  publishAllowed as userCanPublish,
  redeemFirstAccess,
  resetUserPassword,
  saveUsers,
  setUserPassword,
  userStamp,
  verifyUserLogin,
} from "./users.mjs";
import { countViewers, dropViewer, listRoster, touchRoster, touchViewer, SAD_GIFS } from "./public/theater.mjs";
import { cleanNick } from "./public/nick-tag.mjs";
import { renderFirstAccessPage } from "./public/first-access.mjs";
import {
  ACCESS_OWNER,
  ACCESS_PERM,
  ACCESS_TEMP,
  createGuest,
  createPermanentGuest,
  detectGuestKind,
  findGuestInvite,
  guestEndMessage,
  normalizeGuestStore,
  PERMANENT_SESSION_MS,
} from "./public/guest-link.mjs";

const PORT = Number(process.env.PORT || 8080);
const VIEWER_USER = process.env.VIEWER_USER || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const MTX_API_URL = (process.env.MTX_API_URL || "http://spartan-live-motor:9997").replace(/\/$/, "");
const MTX_HLS_URL = (process.env.MTX_HLS_URL || "http://spartan-live-motor:8888").replace(/\/$/, "");
const MTX_USER = process.env.MTX_USER || "";
const MTX_PASSWORD = process.env.MTX_PASSWORD || "";
// Segredo que o motor manda no authHTTPAddress. Sem ele, /api/mtx-auth responde 503.
const MTX_AUTH_SECRET = process.env.MTX_AUTH_SECRET || "";

const COOKIE = "spartan_live";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "download");
const DOWNLOAD_FILE = "SpartanLive.exe";
const GUARD = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy": "frame-ancestors 'none'",
};
const DATA_DIR = process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "data");
const PASSWORD_FILE = path.join(DATA_DIR, "password.json");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const ADMIN_FILE = path.join(DATA_DIR, "admin-inicial.txt");
const GUEST_FILE = path.join(DATA_DIR, "guest.json");
const THUMB_DIR = path.join(DATA_DIR, "thumbs");
const THUMB_MAX = 1_500_000;
const thumbMiss = new Map();
const fails = new Map();
const stoppedUntil = new Map();
const switchingUntil = new Map();
const viewersByStream = new Map();
const guestsByStream = new Map();
const permanentGuestsByStream = new Map();
const rosterByStream = new Map();
const shareByStream = new Map();
// users.json é lido em quase todo pedido (sessão, publish, admin). Igual ao guest.json:
// guarda o último conteúdo e só relê quando o arquivo muda.
let usersCache = { key: "", store: null };

function adminName() {
  return VIEWER_USER || "spartan";
}

function usersFileKey() {
  try {
    const stat = fs.statSync(USERS_FILE);
    return stat.mtimeMs + ":" + stat.size;
  } catch {
    return "";
  }
}

function readUsersStore() {
  const key = usersFileKey();
  if (key && usersCache.key === key && usersCache.store) return usersCache.store;
  const loaded = loadUsers(USERS_FILE, { adminUser: adminName(), legacyFile: PASSWORD_FILE });
  if (loaded.initialPassword) {
    // Só acontece na primeira subida de uma instalação nova. Fica no volume para o dono
    // ler pelo container; o log serve de segunda via e nunca repete depois.
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(ADMIN_FILE, loaded.initialPassword + "\n", { mode: 0o600 });
    } catch {
      /* volume sem permissão: o log ainda mostra */
    }
    console.warn(
      "Admin " + adminName() + " criado. Senha inicial: " + loaded.initialPassword +
      " (também em " + ADMIN_FILE + "). Troque no primeiro acesso.",
    );
  }
  usersCache = { key: usersFileKey(), store: loaded.store };
  return loaded.store;
}

function writeUsersStore(store) {
  saveUsers(USERS_FILE, store);
  usersCache = { key: usersFileKey(), store };
  return store;
}

// Relê o users.json do disco (testes e edição feita por fora, como o admin-reset.sh).
export function reloadUsers() {
  usersCache = { key: "", store: null };
  return readUsersStore();
}

function sessionUser(name) {
  try {
    return findUser(readUsersStore(), name);
  } catch {
    return null;
  }
}

// Marca da senha atual de um usuário. Vai dentro do cookie: quando a senha troca (ou é
// redefinida), todo cookie emitido antes deixa de valer.
export function sessionPasswordStamp(user = adminName()) {
  const found = sessionUser(user);
  return found ? userStamp(found) : "";
}

// Memória de tentativas por IP: poda quem errou uma vez e nunca mais voltou.
const FAILS_KEEP_MS = 10 * 60 * 1000;

function pruneFails(now = Date.now()) {
  if (fails.size <= 500) return;
  for (const [ip, state] of fails) {
    const last = Number(state?.at || 0);
    if (now >= Number(state?.until || 0) && now - last > FAILS_KEEP_MS) fails.delete(ip);
  }
}

// guest.json é lido em quase todo pedido. Guarda o último conteúdo e só relê quando o
// arquivo muda (mtime + tamanho) — antes era um readFileSync por requisição.
let guestFileCache = { key: "", raw: null };

function readGuestFile() {
  let stat;
  try {
    stat = fs.statSync(GUEST_FILE);
  } catch {
    return null;
  }
  const key = `${stat.mtimeMs}:${stat.size}`;
  if (guestFileCache.key === key) return guestFileCache.raw;
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(GUEST_FILE, "utf8"));
  } catch {
    raw = null;
  }
  guestFileCache = { key, raw };
  return raw;
}

function loadGuestStore(now = Date.now()) {
  return normalizeGuestStore(readGuestFile(), now);
}

function saveGuestStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temp = `${GUEST_FILE}.tmp`;
  const clean = {
    temporary: store?.temporary || null,
    permanent: store?.permanent || null,
  };
  fs.writeFileSync(temp, JSON.stringify(clean), { mode: 0o600 });
  fs.renameSync(temp, GUEST_FILE);
  guestFileCache = { key: "", raw: clean };
}

function accessIdFromKind(kind) {
  if (kind === "permanent") return ACCESS_PERM;
  if (kind === "temporary") return ACCESS_TEMP;
  return 0;
}

function openSession(req, now = Date.now()) {
  const data = readSession(cookies(req)[COOKIE], now);
  if (!data) return { session: null, guestEnded: false, guestEnd: "" };
  if (data.role !== "guest") {
    return { session: { ...data, accessId: ACCESS_OWNER }, guestEnded: false, guestEnd: "" };
  }
  // Sempre resolve pelo guest.json atual — cookie antigo com kind errado não manda.
  const found = detectGuestKind(loadGuestStore(now), data.gid, now);
  const stillValid = found
    && (found.kind === "permanent" || (typeof data.exp === "number" && data.exp >= now));
  if (stillValid) {
    return {
      session: {
        ...data,
        kind: found.kind,
        accessId: found.accessId,
        exp: found.kind === "permanent" ? (found.invite.exp || data.exp) : data.exp,
      },
      guestEnded: false,
      guestEnd: "",
    };
  }
  return { session: null, guestEnded: true, guestEnd: data.exp < now ? "expired" : "revoked" };
}

function sessionFrom(req) {
  return openSession(req).session;
}

function sendGuestGone(res, reason = "") {
  const line = guestEndMessage(reason);
  const html = `<!DOCTYPE html>
<meta charset="utf-8">
<title>Spartan Live</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #3a3a3a; color: #ececec; font-family: "Segoe UI", sans-serif; text-align: center; }
  img { width: min(280px, 70vw); height: auto; }
  p { margin: 16px; font-size: 22px; }
</style>
<main>
  <div>
    <img id="gif" src="${SAD_GIFS[0]}" alt="">
    <p>${line}</p>
  </div>
</main>
<script>
  const gifs = ${JSON.stringify(SAD_GIFS)};
  let i = 0;
  setInterval(() => {
    i = (i + 1) % gifs.length;
    document.querySelector("#gif").src = gifs[i];
  }, 4000);
</script>`;
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    ...GUARD,
  });
  res.end(html);
}

function guestTempPayload(invite) {
  if (!invite) return null;
  return { active: true, kind: "temporary", exp: invite.exp, hours: invite.hours, path: `/v/${invite.id}` };
}

function guestPermPayload(invite) {
  if (!invite) return null;
  return { active: true, kind: "permanent", path: `/v/${invite.id}` };
}

function guestBarPayload(store) {
  return {
    temporary: guestTempPayload(store?.temporary || null),
    permanent: guestPermPayload(store?.permanent || null),
  };
}

function asFlag(value) {
  return value === true || value === 1 || value === "true";
}

function shareFlags(name) {
  const mark = shareByStream.get(name);
  if (!mark) return { guestsTemp: false, guestsPerm: false };
  return {
    guestsTemp: Boolean(mark.guestsTemp),
    guestsPerm: Boolean(mark.guestsPerm),
  };
}

export function guestInviteKind(session, now = Date.now()) {
  if (!session || session.role !== "guest") return "";
  const found = detectGuestKind(loadGuestStore(now), session.gid, now);
  return found ? found.kind : "";
}

/** 1 senha, 2 temporário, 3 permanente — sempre pelo gid no guest.json. */
export function accessIdOf(session, now = Date.now()) {
  if (!session) return 0;
  if (session.role !== "guest") return ACCESS_OWNER;
  const found = detectGuestKind(loadGuestStore(now), session.gid, now);
  if (found) return found.accessId;
  return 0;
}

export function guestMaySee(session, name, now = Date.now()) {
  const id = accessIdOf(session, now);
  if (id === ACCESS_OWNER) return true;
  if (id === 0) return false;
  const flags = shareFlags(name);
  if (id === ACCESS_TEMP) return Boolean(flags.guestsTemp);
  if (id === ACCESS_PERM) return Boolean(flags.guestsPerm);
  return false;
}

function pickShareFlag(body, keys) {
  if (!body || typeof body !== "object") return undefined;
  for (const key of keys) {
    if (body[key] !== undefined) return asFlag(body[key]);
  }
  return undefined;
}

export function rememberShare(name, guestsTemp, guestsPerm) {
  if (!safeStreamName(name)) return false;
  shareByStream.set(name, {
    guestsTemp: asFlag(guestsTemp),
    guestsPerm: asFlag(guestsPerm),
    at: Date.now(),
  });
  return true;
}

// Opção 1: o caminho da live é a própria conta. Sem isso, uma conta que soubesse a
// senha de outra (ou só o nome) derrubava a live dela. O programa já manda o apelido
// em minúscula, igual ao cadastro, então a comparação é direta.
export function publishTargetOk(user, path) {
  const account = normalizeUserName(user);
  const target = String(path || "").trim();
  return Boolean(account) && target === account;
}

function publisherAllowed(body, name = "") {
  const user = String(body.user || "");
  const password = String(body.password || "");
  if (!publishTargetOk(user, name)) return false;
  try {
    return userCanPublish(readUsersStore(), normalizeUserName(user), password);
  } catch {
    return false;
  }
}

const STATIC = {
  "/": { file: "index.html", type: "text/html; charset=utf-8", cache: "no-cache" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8", cache: "no-cache" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8", cache: "no-cache" },
  "/buffer-math.mjs": { file: "buffer-math.mjs", type: "text/javascript; charset=utf-8", cache: "no-cache" },
  "/presence.mjs": { file: "presence.mjs", type: "text/javascript; charset=utf-8", cache: "no-cache" },
  "/rail-peek.mjs": { file: "rail-peek.mjs", type: "text/javascript; charset=utf-8", cache: "no-cache" },
  "/screen-switch.mjs": { file: "screen-switch.mjs", type: "text/javascript; charset=utf-8", cache: "no-cache" },
  "/quick-return.mjs": { file: "quick-return.mjs", type: "text/javascript; charset=utf-8", cache: "no-cache" },
  "/theater.mjs": { file: "theater.mjs", type: "text/javascript; charset=utf-8", cache: "no-cache" },
  "/guest-link.mjs": { file: "guest-link.mjs", type: "text/javascript; charset=utf-8", cache: "no-cache" },
  "/nick-tag.mjs": { file: "nick-tag.mjs", type: "text/javascript; charset=utf-8", cache: "no-cache" },
  "/view-mode.mjs": { file: "view-mode.mjs", type: "text/javascript; charset=utf-8", cache: "no-cache" },
  "/users-ui.mjs": { file: "users-ui.mjs", type: "text/javascript; charset=utf-8", cache: "no-cache" },
  "/identity-label.mjs": { file: "identity-label.mjs", type: "text/javascript; charset=utf-8", cache: "no-cache" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8", cache: "no-cache" },
  "/mobile.css": { file: "mobile.css", type: "text/css; charset=utf-8", cache: "no-cache" },
  "/entrar.mp3": { file: "entrar.mp3", type: "audio/mpeg", cache: "public, max-age=86400" },
  "/sair.mp3": { file: "sair.mp3", type: "audio/mpeg", cache: "public, max-age=86400" },
  "/spartan-live.png": { file: "spartan-live.png", type: "image/png", cache: "public, max-age=86400" },
  "/play.png": { file: "play.png", type: "image/png", cache: "no-cache" },
  "/pause.png": { file: "pause.png", type: "image/png", cache: "no-cache" },
  ...Object.fromEntries(
    Array.from({ length: 12 }, (_, idx) => [
      `/gifs/sad-${idx + 1}.gif`,
      { file: `gifs/sad-${idx + 1}.gif`, type: "image/gif", cache: "public, max-age=3600" },
    ])
  ),
  ...Object.fromEntries(
    Array.from({ length: 12 }, (_, idx) => [
      `/gifs/happy-${idx + 1}.gif`,
      { file: `gifs/happy-${idx + 1}.gif`, type: "image/gif", cache: "public, max-age=3600" },
    ])
  ),
  "/hls.min.js": { file: "hls.min.js", type: "text/javascript; charset=utf-8", cache: "public, max-age=86400" },
};

const COMPRESSIBLE = /^(?:text\/|application\/json|application\/javascript|image\/svg)/;

// Cada arquivo entra na memória uma vez (com ETag) e só é comprimido na primeira visita.
const staticCache = new Map();

function staticAsset(item) {
  let asset = staticCache.get(item.file);
  if (asset) return asset;
  const body = fs.readFileSync(path.join(PUBLIC_DIR, item.file));
  asset = {
    body,
    etag: `"${crypto.createHash("sha1").update(body).digest("base64url").slice(0, 16)}"`,
    compressible: COMPRESSIBLE.test(item.type),
    gzip: null,
    br: null,
  };
  staticCache.set(item.file, asset);
  return asset;
}

function compressed(asset, coding) {
  if (coding === "br") {
    if (!asset.br) {
      asset.br = zlib.brotliCompressSync(asset.body, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 },
      });
    }
    return asset.br;
  }
  if (!asset.gzip) asset.gzip = zlib.gzipSync(asset.body, { level: 9 });
  return asset.gzip;
}

function acceptsCoding(header, coding) {
  for (const part of String(header || "").toLowerCase().split(",")) {
    const [token, ...params] = part.split(";").map((piece) => piece.trim());
    if (token !== coding && token !== "*") continue;
    const q = params.find((piece) => piece.startsWith("q="));
    if (q && Number(q.slice(2)) === 0) continue;
    return true;
  }
  return false;
}

export function pickEncoding(acceptHeader, compressible) {
  if (!compressible) return "identity";
  if (acceptsCoding(acceptHeader, "br")) return "br";
  if (acceptsCoding(acceptHeader, "gzip")) return "gzip";
  return "identity";
}

export function passwordsMatch(input, expected) {
  const a = crypto.createHash("sha256").update(String(input), "utf8").digest();
  const b = crypto.createHash("sha256").update(String(expected), "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}

export function signSession(user, now = Date.now(), extra = null) {
  const payload = { u: user, exp: now + SESSION_MS };
  if (extra && typeof extra === "object") {
    if (extra.role) payload.role = extra.role;
    if (extra.gid) payload.gid = extra.gid;
    if (extra.kind) payload.kind = extra.kind;
    if (extra.accessId === ACCESS_OWNER || extra.accessId === ACCESS_TEMP || extra.accessId === ACCESS_PERM) {
      payload.accessId = extra.accessId;
    }
    if (typeof extra.exp === "number") payload.exp = extra.exp;
  }
  // Sem papel explícito, o cookie assume o papel que a conta tem no users.json. Assim o
  // cookie nunca fica sem role (o readSession recusa cookie sem papel).
  if (!payload.role) {
    const account = sessionUser(user);
    payload.role = account ? account.role : ROLE_USER;
  }
  // A sessão do dono carrega a marca da senha atual; a de convidado não depende dela
  // (o convite é revogado pelo guest.json, não pela senha do dono).
  if (payload.role !== "guest") {
    const stamp = typeof extra?.pv === "string" ? extra.pv : sessionPasswordStamp(user);
    if (stamp) payload.pv = stamp;
  }
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function readSession(token, now = Date.now()) {
  if (!token || !SESSION_SECRET || !VIEWER_USER) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!data || typeof data.exp !== "number") return null;
    // Convite de convidado continua preso ao nome dono que o emitiu.
    if (data.role === "guest") return data.u === (VIEWER_USER || "spartan") ? data : null;
    // Sessão de conta: o usuário precisa existir, manter o mesmo papel e a mesma senha.
    // Excluir alguém ou redefinir a senha derruba o cookie na hora, sem esperar vencer.
    const user = sessionUser(data.u);
    if (!user) return null;
    if (data.role !== user.role) return null;
    if (data.pv !== userStamp(user)) return null;
    if (data.exp < now) return null;
    return data;
  } catch {
    return null;
  }
}

export function safeStreamName(name) {
  return /^[a-zA-Z0-9_-]{1,32}$/.test(name);
}

export function requestPath(raw) {
  try {
    const pathname = decodeURIComponent(String(raw || "/"));
    if (!pathname.startsWith("/") || pathname.includes("\0")) return "";
    if (pathname.split("/").some((part) => part === "." || part === "..")) return "";
    return pathname;
  } catch {
    return "";
  }
}

export function safeHlsRest(rest) {
  if (!rest || rest.length > 180 || rest.includes("..")) return false;
  return /^[A-Za-z0-9._-]+$/.test(rest);
}

export function safeHlsSearch(search) {
  if (!search) return "";
  if (search.length > 200 || !/^\?[A-Za-z0-9._~%=&+-]*$/.test(search)) return "";
  return search;
}

export function publisherDownload() {
  const root = path.resolve(DOWNLOAD_DIR);
  const filePath = path.resolve(root, DOWNLOAD_FILE);
  const relative = path.relative(root, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    return { path: filePath, size: stat.size };
  } catch {
    return null;
  }
}

function cookies(req) {
  const out = {};
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (!key) continue;
    const value = part.slice(i + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      // Cookie com % solto não derruba o pedido: fica o valor cru, a assinatura não
      // confere e o visitante simplesmente cai na tela de login.
      out[key] = value;
    }
  }
  return out;
}

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  const chain = typeof forwarded === "string" && forwarded.length < 200 ? forwarded : "";
  return pickClientIp(req.socket.remoteAddress, chain).slice(0, 64);
}

function watcherKey(req, guest, kind = "") {
  const who = guest ? (kind === "permanent" ? "gp" : "g") : "o";
  const agent = String(req.headers["user-agent"] || "").slice(0, 64);
  return `${who}|${clientIp(req)}|${agent}`;
}

// Quem pode dizer o IP do visitante pelo X-Forwarded-For: só o gateway da própria
// rede do container (é por ele que o nginx-proxy-manager chega) e o loopback.
// Antes, qualquer 10/8 ou 172.16/12 valia — LAN, VPN e outros containers podiam
// forjar o header, escapar do bloqueio por IP e inventar espectador.
function ipv4ToInt(ip) {
  const parts = String(ip).split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function normalizeIp(raw) {
  return String(raw || "").trim().replace(/^::ffff:/, "");
}

export function makeTrustedProxies(spec = "", gateways = []) {
  const exact = new Set(["127.0.0.1", "::1"]);
  const nets = [];
  const add = (text) => {
    const clean = normalizeIp(text);
    if (!clean) return;
    const slash = clean.indexOf("/");
    if (slash < 0) {
      exact.add(clean);
      return;
    }
    const base = ipv4ToInt(clean.slice(0, slash));
    const bits = Number(clean.slice(slash + 1));
    if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    nets.push({ net: (base & mask) >>> 0, mask });
  };
  for (const gateway of gateways || []) add(`${normalizeIp(gateway)}/32`);
  for (const part of String(spec).split(",")) add(part);
  return (ip) => {
    const clean = normalizeIp(ip);
    if (!clean) return false;
    if (exact.has(clean)) return true;
    const value = ipv4ToInt(clean);
    if (value === null) return false;
    return nets.some((net) => ((value & net.mask) >>> 0) === net.net);
  };
}

// Gateway padrão do próprio container: no Docker é o único caminho de entrada.
function gatewayIps() {
  try {
    const out = [];
    for (const line of fs.readFileSync("/proc/net/route", "utf8").split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 8 || cols[1] !== "00000000") continue;
      const hex = cols[2];
      if (!/^[0-9A-Fa-f]{8}$/.test(hex)) continue;
      out.push(hex.match(/../g).reverse().map((piece) => parseInt(piece, 16)).join("."));
    }
    return out;
  } catch {
    return [];
  }
}

const TRUSTED_PROXIES = makeTrustedProxies(process.env.TRUSTED_PROXIES || "", gatewayIps());

function trustedProxy(remote) {
  return TRUSTED_PROXIES(remote);
}

// O X-Forwarded-For é uma lista em que cada proxy anexa o IP de quem falou com ele.
// O começo da lista pode ter sido inventado pelo cliente, então a leitura é da
// direita para a esquerda: o primeiro IP que não é proxy confiável é o visitante.
export function pickClientIp(remote, forwarded, trusted = TRUSTED_PROXIES) {
  const direct = normalizeIp(remote) || "local";
  if (!trusted(direct)) return direct;
  const chain = String(forwarded || "")
    .split(",")
    .map(normalizeIp)
    .filter((ip) => ip.length > 0 && ip.length <= 45);
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    if (!trusted(chain[i])) return chain[i];
  }
  return chain[0] || direct;
}

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...GUARD,
    ...extraHeaders,
  });
  res.end(payload);
}

function cookieHeader(token, req, clear = false, maxAgeSeconds = SESSION_MS / 1000) {
  // x-forwarded-proto só vale quando quem falou é o proxy: um cliente direto
  // marcando "https" só conseguiria um cookie Secure que ele mesmo não devolve.
  const https = req.socket.encrypted
    || (trustedProxy(req.socket.remoteAddress) && req.headers["x-forwarded-proto"] === "https");
  const parts = [
    `${COOKIE}=${clear ? "" : encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${clear ? 0 : Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (https) parts.push("Secure");
  return parts.join("; ");
}

function mtxAuthorization() {
  return `Basic ${Buffer.from(`${MTX_USER}:${MTX_PASSWORD}`).toString("base64")}`;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2048) {
      const error = new Error("payload grande demais");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("json invalido");
    error.status = 400;
    throw error;
  }
}

async function handleLogin(req, res) {
  const ip = clientIp(req);
  pruneFails();
  const state = fails.get(ip) || { count: 0, until: 0, at: 0 };
  state.at = Date.now();
  if (Date.now() < state.until) {
    sendJson(res, 429, { error: "Espera um pouco e tenta de novo." });
    return;
  }

  const body = await readJson(req);
  const store = readUsersStore();
  // O nome pode vir com maiúscula; a conta é sempre minúscula.
  const attempt = verifyUserLogin(store, normalizeUserName(body.user || ""), body.password || "");
  if (!attempt.ok) {
    state.count += 1;
    if (state.count >= 8) {
      state.until = Date.now() + 5 * 60 * 1000;
      state.count = 0;
    }
    fails.set(ip, state);
    // A mesma resposta para nome inexistente, conta sem senha e senha errada.
    sendJson(res, 401, { error: "Nome ou senha não confere." });
    return;
  }

  writeUsersStore(store);
  fails.delete(ip);
  sendJson(res, 200, {
    ok: true,
    user: attempt.user.user,
    role: attempt.user.role,
    mustChange: Boolean(attempt.user.mustChange),
  }, {
    "set-cookie": cookieHeader(
      signSession(attempt.user.user, Date.now(), { role: attempt.user.role, pv: userStamp(attempt.user) }),
      req,
    ),
  });
}

// Todo espectador pergunta de 3 em 3 segundos. O motor não precisa ser consultado por
// cada um: 900 ms de cache e um único pedido em voo para todos.
const STREAMS_CACHE_MS = 900;
let streamsCache = { at: 0, list: null };
let streamsInflight = null;

async function fetchStreams() {
  const response = await fetch(`${MTX_API_URL}/v3/paths/list?itemsPerPage=100`, {
    headers: { authorization: mtxAuthorization() },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    const error = new Error(`mediamtx api ${response.status}`);
    error.status = 502;
    throw error;
  }
  const data = await response.json();
  const items = Array.isArray(data.items) ? data.items : [];
  return items
    .filter((item) => item && item.ready && safeStreamName(item.name))
    .map((item) => ({ name: item.name, readyTime: item.readyTime || null }))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

async function listStreams() {
  const now = Date.now();
  if (streamsCache.list && now - streamsCache.at < STREAMS_CACHE_MS) return streamsCache.list;
  if (streamsInflight) return streamsInflight;
  streamsInflight = fetchStreams()
    .then((list) => {
      streamsCache = { at: Date.now(), list };
      return list;
    })
    .finally(() => {
      streamsInflight = null;
    });
  return streamsInflight;
}

async function proxyHls(req, res, name, rest, search) {
  const target = `${MTX_HLS_URL}/${encodeURIComponent(name)}/${rest}${search}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  // Fica no res (um por requisição), não no socket: o keep-alive reusa o socket e
  // acumulava um listener novo a cada segmento até o Node reclamar do vazamento.
  const abortUpstream = () => {
    if (!res.writableFinished) controller.abort();
  };
  res.on("close", abortUpstream);
  let upstream;
  try {
    upstream = await fetch(target, {
      headers: { authorization: mtxAuthorization() },
      signal: controller.signal,
    });
  } catch (error) {
    // Espectador saiu da página ou o segmento demorou: não é erro do site.
    if (controller.signal.aborted) return;
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (res.destroyed) {
    await upstream.body?.cancel();
    return;
  }
  const headers = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
  const type = upstream.headers.get("content-type");
  if (type) headers["content-type"] = type;
  res.writeHead(upstream.status, headers);
  if (!upstream.body) {
    res.end();
    return;
  }
  const stream = Readable.fromWeb(upstream.body);
  const stop = () => {
    stream.destroy();
  };
  res.on("close", stop);
  stream.pipe(res);
}

function currentStopped(streams) {
  const now = Date.now();
  const readyAt = new Map((streams || []).map((stream) => [stream.name, Date.parse(stream.readyTime || "")]));
  const names = [];
  for (const [name, mark] of stoppedUntil) {
    const until = typeof mark === "number" ? mark : mark.until;
    const at = typeof mark === "number" ? until - 2 * 60 * 1000 : mark.at;
    const ready = readyAt.get(name);
    if (until <= now || (Number.isFinite(ready) && ready > at + 4000)) {
      stoppedUntil.delete(name);
      continue;
    }
    names.push(name);
  }
  return names;
}

async function kickPath(name) {
  try {
    await fetch(`${MTX_API_URL}/v3/paths/kick/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { authorization: mtxAuthorization() },
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    /* a live some quando o caminho cair, ou quando a nova sessão ficar pronta */
  }
}

export function thumbFile(name, root = THUMB_DIR) {
  if (!safeStreamName(name)) return null;
  const base = path.resolve(root);
  const filePath = path.resolve(base, `${name}.jpg`);
  const relative = path.relative(base, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return filePath;
}

function thumbStamp(name) {
  const filePath = thumbFile(name);
  if (!filePath) return 0;
  try {
    return Math.round(fs.statSync(filePath).mtimeMs);
  } catch {
    return 0;
  }
}

function deleteThumb(name) {
  const filePath = thumbFile(name);
  thumbMiss.delete(name);
  if (!filePath) return;
  fs.rmSync(filePath, { force: true });
}

function saveThumb(name, bytes) {
  const filePath = thumbFile(name);
  if (!filePath || !Buffer.isBuffer(bytes) || bytes.length < 32 || bytes.length > THUMB_MAX) return false;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp`;
  fs.writeFileSync(temp, bytes);
  fs.renameSync(temp, filePath);
  thumbMiss.delete(name);
  return true;
}

function sweepThumbs(liveNames, switchingNames, now = Date.now()) {
  const keep = new Set([...(liveNames || []), ...(switchingNames || [])]);
  let files = [];
  try {
    files = fs.readdirSync(THUMB_DIR);
  } catch {
    return;
  }
  for (const file of files) {
    if (!file.endsWith(".jpg")) continue;
    const name = file.slice(0, -4);
    if (!safeStreamName(name)) {
      fs.rmSync(path.join(THUMB_DIR, file), { force: true });
      continue;
    }
    if (keep.has(name)) {
      thumbMiss.delete(name);
      continue;
    }
    const since = thumbMiss.get(name) || now;
    if (!thumbMiss.has(name)) thumbMiss.set(name, since);
    if (now - since >= 90_000) deleteThumb(name);
  }
}

// A varredura da pasta é síncrona e cara; 30 s bastam para limpar o que sumiu (o corte é 90 s).
let lastThumbSweep = 0;

function sweepThumbsThrottled(liveNames, switchingNames, now = Date.now()) {
  if (now - lastThumbSweep < 30_000) return;
  lastThumbSweep = now;
  sweepThumbs(liveNames, switchingNames, now);
}

async function readBytes(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error("payload grande demais");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function handleThumb(req, res) {
  const user = String(req.headers["x-spartan-user"] || "");
  const password = String(req.headers["x-spartan-password"] || "");
  const name = String(req.headers["x-spartan-name"] || "");
  if (!publisherAllowed({ user, password }, name) || !safeStreamName(name)) {
    sendJson(res, 401, { error: "nao autorizado" });
    return;
  }
  const mark = stoppedUntil.get(name);
  const until = typeof mark === "number" ? mark : mark?.until;
  if (until && until > Date.now()) {
    sendJson(res, 409, { error: "live encerrada" });
    return;
  }
  const bytes = await readBytes(req, THUMB_MAX);
  if (!saveThumb(name, bytes)) {
    sendJson(res, 400, { error: "imagem invalida" });
    return;
  }
  sendJson(res, 200, { ok: true });
}

async function handleStop(req, res) {
  const body = await readJson(req);
  const name = String(body.name || "");
  if (!publisherAllowed(body, name) || !safeStreamName(name)) {
    sendJson(res, 401, { error: "nao autorizado" });
    return;
  }
  const at = Date.now();
  stoppedUntil.set(name, { at, until: at + 2 * 60 * 1000 });
  deleteThumb(name);
  await kickPath(name);
  sendJson(res, 200, { ok: true });
}

export function collectSwitching(marks, streams, now = Date.now()) {
  const readyAt = new Map((streams || []).map((stream) => [stream.name, Date.parse(stream.readyTime || "")]));
  const names = [];
  for (const [name, mark] of marks) {
    const ready = readyAt.get(name);
    const back = Number.isFinite(ready) && ready > mark.at + 1500;
    if (mark.until <= now || back) {
      marks.delete(name);
      continue;
    }
    names.push(name);
  }
  return names;
}

export function collectSwitchKinds(marks) {
  const kinds = {};
  for (const [name, mark] of marks) {
    if (mark?.kind) kinds[name] = mark.kind;
  }
  return kinds;
}

async function handleSwitch(req, res) {
  const body = await readJson(req);
  const name = String(body.name || "");
  if (!publisherAllowed(body, name) || !safeStreamName(name)) {
    sendJson(res, 401, { error: "nao autorizado" });
    return;
  }
  const at = Date.now();
  const kind = body.kind === "quality" ? "quality" : "screen";
  switchingUntil.set(name, { at, until: at + 20000, kind });
  sendJson(res, 200, { ok: true });
}

async function handleClaim(req, res) {
  const body = await readJson(req);
  const name = String(body.name || "");
  if (!publisherAllowed(body, name) || !safeStreamName(name)) {
    sendJson(res, 401, { error: "nao autorizado" });
    return;
  }
  stoppedUntil.delete(name);
  await kickPath(name);
  sendJson(res, 200, { ok: true });
}

async function handlePassword(req, res) {
  const session = sessionFrom(req);
  if (!session || session.role === "guest") {
    sendJson(res, 401, { error: "sem sessao" });
    return;
  }
  const ip = clientIp(req);
  pruneFails();
  const state = fails.get(ip) || { count: 0, until: 0, at: 0 };
  state.at = Date.now();
  if (Date.now() < state.until) {
    sendJson(res, 429, { error: "Espera um pouco e tenta de novo." });
    return;
  }
  const body = await readJson(req);
  const current = String(body.current || "");
  const next = String(body.next || "");
  const again = String(body.again || "");
  const store = readUsersStore();
  const user = findUser(store, session.u);
  if (!user || !user.hash) {
    sendJson(res, 401, { error: "sem sessao" });
    return;
  }
  if (!verifyUserLogin(store, user.user, current).ok) {
    state.count += 1;
    if (state.count >= 8) {
      state.until = Date.now() + 5 * 60 * 1000;
      state.count = 0;
    }
    fails.set(ip, state);
    sendJson(res, 401, { error: "A senha atual não confere." });
    return;
  }
  const problem = checkPassword(user.user, next);
  if (problem) {
    sendJson(res, 400, { error: problem });
    return;
  }
  if (next !== again) {
    sendJson(res, 400, { error: "A senha nova não está igual nos dois campos." });
    return;
  }
  if (next === current) {
    sendJson(res, 400, { error: "Escolhe uma senha diferente da atual." });
    return;
  }
  fails.delete(ip);
  const saved = setUserPassword(store, user.user, next);
  if (saved.error) {
    sendJson(res, saved.status || 400, { error: saved.error });
    return;
  }
  writeUsersStore(store);
  // A senha mudou: quem trocou recebe um cookie novo na hora e os outros aparelhos
  // caem no login (o cookie deles tem a marca da senha antiga).
  sendJson(res, 200, { ok: true }, {
    "set-cookie": cookieHeader(
      signSession(saved.user.user, Date.now(), { role: saved.user.role, pv: userStamp(saved.user) }),
      req,
    ),
  });
}

// --- contas e primeiro acesso ---------------------------------------------

function firstAccessToken(raw) {
  const token = String(raw || "").trim();
  return /^[A-Za-z0-9_-]{16,64}$/.test(token) ? token : "";
}

async function handleFirstAccessInfo(req, res, url) {
  const token = firstAccessToken(url.searchParams.get("t"));
  const user = token ? findFirstAccess(readUsersStore(), token) : null;
  if (!user) {
    sendJson(res, 410, { error: "Esse link já foi usado ou venceu." });
    return;
  }
  sendJson(res, 200, { user: user.user });
}

async function handleFirstAccessSet(req, res) {
  const ip = clientIp(req);
  pruneFails();
  const state = fails.get(ip) || { count: 0, until: 0, at: 0 };
  state.at = Date.now();
  if (Date.now() < state.until) {
    sendJson(res, 429, { error: "Espera um pouco e tenta de novo." });
    return;
  }
  const body = await readJson(req);
  const token = firstAccessToken(body.t);
  const password = String(body.password || "");
  const again = String(body.again || "");
  if (password !== again) {
    sendJson(res, 400, { error: "As duas senhas não estão iguais." });
    return;
  }
  const store = readUsersStore();
  const redeemed = redeemFirstAccess(store, token, password);
  if (redeemed.error) {
    state.count += 1;
    if (state.count >= 8) {
      state.until = Date.now() + 5 * 60 * 1000;
      state.count = 0;
    }
    fails.set(ip, state);
    sendJson(res, redeemed.status || 400, { error: redeemed.error });
    return;
  }
  writeUsersStore(store);
  fails.delete(ip);
  sendJson(res, 200, { ok: true, user: redeemed.user.user, role: redeemed.user.role }, {
    "set-cookie": cookieHeader(
      signSession(redeemed.user.user, Date.now(), { role: redeemed.user.role, pv: userStamp(redeemed.user) }),
      req,
    ),
  });
}

function requireAdmin(req, res) {
  const session = openSession(req).session;
  if (!session) {
    sendJson(res, 401, { error: "sem sessao" });
    return null;
  }
  if (session.role !== ROLE_ADMIN) {
    sendJson(res, 403, { error: "Só o admin pode fazer isso." });
    return null;
  }
  return session;
}

async function handleAdminUsers(req, res, pathname) {
  const session = requireAdmin(req, res);
  if (!session) return;

  if (req.method === "GET") {
    const store = readUsersStore();
    const users = store.users
      .map((user) => publicUser(user))
      .sort((a, b) => {
        if (a.role !== b.role) return a.role === ROLE_ADMIN ? -1 : 1;
        return a.user.localeCompare(b.user);
      });
    sendJson(res, 200, { admin: session.u, users });
    return;
  }

  const body = await readJson(req);
  const name = normalizeUserName(body.user || "");
  const store = readUsersStore();

  if (pathname === "/api/admin/users/delete") {
    if (name === normalizeUserName(session.u)) {
      sendJson(res, 409, { error: "Para excluir a própria conta, use outra conta admin." });
      return;
    }
    const removed = deleteUser(store, name);
    if (removed.error) {
      sendJson(res, removed.status || 400, { error: removed.error });
      return;
    }
    writeUsersStore(store);
    sendJson(res, 200, { ok: true, user: name });
    return;
  }

  if (pathname === "/api/admin/users/reset") {
    const reset = resetUserPassword(store, name);
    if (reset.error) {
      sendJson(res, reset.status || 400, { error: reset.error });
      return;
    }
    writeUsersStore(store);
    sendJson(res, 200, { ok: true, path: firstAccessPath(reset.token), user: publicUser(reset.user) });
    return;
  }

  const made = createUser(store, name);
  if (made.error) {
    sendJson(res, made.status || 400, { error: made.error });
    return;
  }
  writeUsersStore(store);
  sendJson(res, 200, { ok: true, path: firstAccessPath(made.token), user: publicUser(made.user) });
}

// --- autorização do motor (authMethod: http) -------------------------------

const mtxFails = new Map();

function mtxSecretOk(given) {
  if (!MTX_AUTH_SECRET) return false;
  const a = crypto.createHash("sha256").update(String(given || "")).digest();
  const b = crypto.createHash("sha256").update(MTX_AUTH_SECRET).digest();
  return crypto.timingSafeEqual(a, b);
}

async function handleMtxAuth(req, res, url) {
  if (!MTX_AUTH_SECRET) {
    sendJson(res, 503, { error: "auth do motor não configurada" });
    return;
  }
  const ip = clientIp(req);
  const state = mtxFails.get(ip) || { count: 0, until: 0, at: 0 };
  state.at = Date.now();
  if (Date.now() < state.until) {
    sendJson(res, 429, { error: "muitas tentativas" });
    return;
  }
  if (!mtxSecretOk(url.searchParams.get("secret"))) {
    sendJson(res, 401, { error: "nao autorizado" });
    return;
  }

  const body = await readJson(req);
  const action = String(body.action || "");
  const user = String(body.user || "");
  const password = String(body.password || "");
  let allowed = false;

  if (action === "publish") {
    // Mesma conta e mesma senha do site. Conta sem senha (link não usado) não publica.
    // O caminho publicado tem que ser o nome da conta (Opção 1): o motor manda o path
    // no corpo do pedido, então dá para conferir aqui antes de liberar o ffmpeg.
    try {
      allowed = publishTargetOk(user, body.path)
        && userCanPublish(readUsersStore(), normalizeUserName(user), password);
    } catch {
      allowed = false;
    }
  } else if (action === "read" || action === "api" || action === "metrics" || action === "pprof" || action === "playback") {
    // Leitura e API só pela conta de serviço do site, dentro da rede do compose.
    allowed = Boolean(MTX_USER) && Boolean(MTX_PASSWORD)
      && passwordsMatch(user, MTX_USER) && passwordsMatch(password, MTX_PASSWORD);
  }

  if (!allowed) {
    state.count += 1;
    if (state.count >= 20) {
      state.until = Date.now() + 60 * 1000;
      state.count = 0;
    }
    mtxFails.set(ip, state);
    sendJson(res, 401, { error: "nao autorizado" });
    return;
  }
  mtxFails.delete(ip);
  sendJson(res, 200, { ok: true, user: action === "publish" ? normalizeUserName(user) : user });
}

async function handle(req, res) {
  const url = new URL(req.url || "/", "http://localhost");
  const pathname = requestPath(url.pathname);
  if (!pathname) {
    sendJson(res, 400, { error: "caminho invalido" });
    return;
  }

  if (req.method === "GET" && pathname === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Link de primeiro acesso: página própria, sem cookie e sem depender do app.js.
  if (req.method === "GET" && pathname.startsWith(FIRST_ACCESS_PAGE)) {
    const token = firstAccessToken(pathname.slice(FIRST_ACCESS_PAGE.length));
    const account = token ? findFirstAccess(readUsersStore(), token) : null;
    if (!account) {
      res.writeHead(410, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        ...GUARD,
      });
      res.end(`<!DOCTYPE html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Spartan Live</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#3a3a3a;color:#ececec;font-family:"Segoe UI",sans-serif;text-align:center;padding:24px}p{font-size:18px;line-height:1.5;max-width:420px}</style>
<p>Esse link de primeiro acesso já foi usado ou venceu.<br>Peça um novo link ao admin.</p>`);
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...GUARD,
    });
    res.end(renderFirstAccessPage(account.user, token));
    return;
  }

  if (req.method === "POST" && pathname === "/api/login") {
    await handleLogin(req, res);
    return;
  }

  if (pathname === "/api/first-access") {
    if (req.method === "GET") {
      await handleFirstAccessInfo(req, res, url);
      return;
    }
    if (req.method === "POST") {
      await handleFirstAccessSet(req, res);
      return;
    }
  }

  if (pathname === "/api/admin/users" || pathname === "/api/admin/users/reset" || pathname === "/api/admin/users/delete") {
    await handleAdminUsers(req, res, pathname);
    return;
  }

  // O motor chama esta rota (authMethod: http). Fora do segredo não responde nada.
  if (req.method === "POST" && pathname === "/api/mtx-auth") {
    await handleMtxAuth(req, res, url);
    return;
  }

  if (req.method === "POST" && pathname === "/api/stop") {
    await handleStop(req, res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/thumb") {
    await handleThumb(req, res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/claim") {
    await handleClaim(req, res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/switch") {
    await handleSwitch(req, res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/viewers") {
    const body = await readJson(req);
    const name = String(body.name || "");
    if (!publisherAllowed(body, name) || !safeStreamName(name)) {
      sendJson(res, 401, { error: "nao autorizado" });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      viewers: countViewers(viewersByStream, name),
      guests: countViewers(guestsByStream, name),
      permanent: countViewers(permanentGuestsByStream, name),
      people: listRoster(rosterByStream, name),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/share") {
    const body = await readJson(req);
    const name = String(body.name || "");
    if (!publisherAllowed(body, name) || !safeStreamName(name)) {
      sendJson(res, 401, { error: "nao autorizado" });
      return;
    }
    // accessId 2 = temporário; accessId 3 = permanente
    const allowTemp = pickShareFlag(body, ["allowTemp", "guestsTemp", "temporary", "temp", "guests"]);
    const allowPerm = pickShareFlag(body, ["allowPerm", "guestsPerm", "permanent", "perm"]);
    rememberShare(name, allowTemp === undefined ? false : allowTemp, allowPerm === undefined ? false : allowPerm);
    const flags = shareFlags(name);
    sendJson(res, 200, {
      ok: true,
      guestsTemp: flags.guestsTemp,
      guestsPerm: flags.guestsPerm,
      allowTemp: flags.guestsTemp,
      allowPerm: flags.guestsPerm,
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/logout") {
    sendJson(res, 200, { ok: true }, { "set-cookie": cookieHeader("", req, true) });
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/v/")) {
    const id = pathname.slice("/v/".length);
    const found = /^[\w-]{16,64}$/.test(id) ? findGuestInvite(loadGuestStore(), id) : null;
    if (!found) {
      const data = readSession(cookies(req)[COOKIE]);
      const reason = data?.role === "guest" && data.gid === id
        ? (data.exp < Date.now() ? "expired" : "revoked")
        : "";
      sendGuestGone(res, reason);
      return;
    }
    const invite = found.invite;
    const token = signSession(VIEWER_USER || "spartan", Date.now(), {
      role: "guest",
      gid: invite.id,
      kind: found.kind,
      accessId: accessIdFromKind(found.kind),
      exp: invite.exp,
    });
    const left = found.kind === "permanent"
      ? Math.floor(PERMANENT_SESSION_MS / 1000)
      : Math.max(1, Math.ceil((invite.exp - Date.now()) / 1000)) + 24 * 60 * 60;
    res.writeHead(302, {
      Location: "/",
      "set-cookie": cookieHeader(token, req, false, left),
      "cache-control": "no-store",
      ...GUARD,
    });
    res.end();
    return;
  }

  const opened = openSession(req);
  const session = opened.session;
  const guest = session?.role === "guest";

  function linkEnded() {
    if (!opened.guestEnded) return false;
    sendJson(res, 401, {
      error: "link acabou",
      guestEnded: true,
      guestEnd: opened.guestEnd || "revoked",
    });
    return true;
  }

  function needsLogin() {
    if (linkEnded()) return true;
    if (!session) {
      sendJson(res, 401, { error: "sem sessao" });
      return true;
    }
    return false;
  }

  function ownerLocked() {
    if (guest) return false;
    const account = sessionUser(session.u);
    if (account && account.hash && !account.mustChange) return false;
    sendJson(res, 403, { error: "Troque a senha antes de entrar.", mustChange: true });
    return true;
  }

  if (req.method === "GET" && pathname === "/api/me") {
    if (needsLogin()) return;
    const accessId = accessIdOf(session);
    const account = guest ? null : sessionUser(session.u);
    sendJson(res, 200, {
      user: session.u,
      role: guest ? "guest" : (account ? account.role : ROLE_USER),
      kind: guest ? guestInviteKind(session) : "",
      accessId,
      mustChange: guest || !account ? false : Boolean(account.mustChange || !account.hash),
      exp: guest ? session.exp : 0,
    });
    return;
  }

  if (pathname === "/api/guest" || pathname === "/api/guest/revoke") {
    if (linkEnded()) return;
    if (!session || guest) {
      sendJson(res, 401, { error: "sem sessao" });
      return;
    }
    if (req.method === "GET" && pathname === "/api/guest") {
      sendJson(res, 200, guestBarPayload(loadGuestStore()));
      return;
    }
    if (req.method === "POST" && pathname === "/api/guest/revoke") {
      const body = await readJson(req);
      const kind = body.kind === "permanent" ? "permanent" : "temporary";
      const store = loadGuestStore();
      store[kind] = null;
      if (!store.temporary && !store.permanent) {
        try { fs.unlinkSync(GUEST_FILE); } catch { /* já não estava */ }
      } else {
        saveGuestStore(store);
      }
      sendJson(res, 200, guestBarPayload(store));
      return;
    }
    if (req.method === "POST" && pathname === "/api/guest") {
      const body = await readJson(req);
      const store = loadGuestStore();
      const token = crypto.randomBytes(18).toString("base64url");
      if (body.permanent || body.kind === "permanent") {
        if (store.permanent) {
          sendJson(res, 409, { error: "ja existe um link permanente" });
          return;
        }
        const record = createPermanentGuest(token, Date.now());
        if (!record) {
          sendJson(res, 400, { error: "convite invalido" });
          return;
        }
        store.permanent = record;
        saveGuestStore(store);
        sendJson(res, 200, guestBarPayload(store));
        return;
      }
      if (store.temporary) {
        sendJson(res, 409, { error: "ja existe um link" });
        return;
      }
      const record = createGuest(body.hours, Date.now(), token);
      if (!record) {
        sendJson(res, 400, { error: "prazo invalido" });
        return;
      }
      store.temporary = record;
      saveGuestStore(store);
      sendJson(res, 200, guestBarPayload(store));
      return;
    }
    sendJson(res, 405, { error: "metodo invalido" });
    return;
  }

  if (req.method === "POST" && pathname === "/api/password") {
    await handlePassword(req, res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/watch") {
    if (needsLogin()) return;
    const body = await readJson(req);
    const nick = cleanNick(body.nick);
    if (!nick) {
      sendJson(res, 400, { error: "apelido obrigatorio" });
      return;
    }
    const names = Array.isArray(body.names) ? body.names : [];
    const accessId = accessIdOf(session);
    const kind = accessId === ACCESS_PERM ? "permanent" : (accessId === ACCESS_TEMP ? "temporary" : (guest ? "temporary" : "owner"));
    const viewerKey = watcherKey(req, guest, kind);
    const now = Date.now();
    const book = accessId === ACCESS_OWNER
      ? viewersByStream
      : (accessId === ACCESS_PERM ? permanentGuestsByStream : guestsByStream);
    for (const raw of names) {
      const name = String(raw || "");
      if (safeStreamName(name) && guestMaySee(session, name)) {
        touchViewer(book, name, viewerKey, now);
        touchRoster(rosterByStream, name, viewerKey, nick, kind, now);
      }
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && pathname === "/api/unwatch") {
    if (needsLogin()) return;
    const body = await readJson(req);
    const name = String(body.name || "");
    if (safeStreamName(name)) {
      const accessId = accessIdOf(session);
      const kind = accessId === ACCESS_PERM ? "permanent" : (accessId === ACCESS_TEMP ? "temporary" : "");
      const viewerKey = watcherKey(req, guest, kind);
      dropViewer(viewersByStream, name, viewerKey);
      dropViewer(guestsByStream, name, viewerKey);
      dropViewer(permanentGuestsByStream, name, viewerKey);
      dropViewer(rosterByStream, name, viewerKey);
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && pathname === "/api/audience") {
    if (needsLogin()) return;
    if (guest) {
      sendJson(res, 401, { error: "sem sessao" });
      return;
    }
    const now = Date.now();
    const names = new Set();
    try {
      for (const stream of await listStreams()) names.add(stream.name);
    } catch { /* motor fora: ainda lista quem está pingando */ }
    for (const book of [viewersByStream, guestsByStream, permanentGuestsByStream, rosterByStream]) {
      for (const name of book.keys()) names.add(name);
    }
    const lives = [...names]
      .filter((name) => safeStreamName(name))
      .sort((a, b) => a.localeCompare(b, "pt-BR"))
      .map((name) => ({
        name,
        viewers: countViewers(viewersByStream, name, now),
        guests: countViewers(guestsByStream, name, now),
        permanent: countViewers(permanentGuestsByStream, name, now),
        people: listRoster(rosterByStream, name, now),
      }));
    sendJson(res, 200, { lives });
    return;
  }

  if (req.method === "GET" && pathname === "/api/streams") {
    if (needsLogin() || ownerLocked()) return;
    const live = await listStreams();
    const stopped = currentStopped(live);
    const gone = new Set(stopped);
    const now = Date.now();
    // Lives ativas (sem filtro de convidado) — thumb não some se o convidado não pode ver.
    const visibleLive = live.filter((stream) => !gone.has(stream.name));
    const streams = visibleLive
      .filter((stream) => guestMaySee(session, stream.name))
      .map((stream) => ({
        ...stream,
        thumbAt: thumbStamp(stream.name),
        viewers: countViewers(viewersByStream, stream.name, now),
        guests: countViewers(guestsByStream, stream.name, now),
        permanent: countViewers(permanentGuestsByStream, stream.name, now),
      }));
    const switchingAll = collectSwitching(switchingUntil, visibleLive);
    const switching = switchingAll.filter((name) => guestMaySee(session, name));
    const switchingKinds = collectSwitchKinds(switchingUntil);
    sweepThumbsThrottled(visibleLive.map((stream) => stream.name), switchingAll);
    sendJson(res, 200, { streams, stopped, switching, switchingKinds });
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/hls/")) {
    if (needsLogin() || ownerLocked()) return;
    const pieces = pathname.split("/").filter(Boolean);
    const name = pieces[1] || "";
    const rest = pieces.slice(2).join("/");
    if (!safeStreamName(name) || !safeHlsRest(rest)) {
      sendJson(res, 400, { error: "caminho invalido" });
      return;
    }
    if (!guestMaySee(session, name)) {
      sendJson(res, 404, { error: "live indisponivel" });
      return;
    }
    await proxyHls(req, res, name, rest, safeHlsSearch(url.search));
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/api/thumb/")) {
    if (needsLogin() || ownerLocked()) return;
    const name = pathname.slice("/api/thumb/".length);
    if (!guestMaySee(session, name)) {
      sendJson(res, 404, { error: "sem imagem" });
      return;
    }
    const filePath = thumbFile(name);
    if (!filePath || !fs.existsSync(filePath)) {
      sendJson(res, 404, { error: "sem imagem" });
      return;
    }
    const body = fs.readFileSync(filePath);
    res.writeHead(200, {
      "content-type": "image/jpeg",
      "content-length": body.length,
      "cache-control": "no-store",
      ...GUARD,
    });
    res.end(body);
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/download/SpartanLive.exe") {
    if (linkEnded()) return;
    if (!session || guest) {
      sendJson(res, 401, { error: "sem sessao" });
      return;
    }
    if (ownerLocked()) return;
    const file = publisherDownload();
    if (!file) {
      sendJson(res, 404, { error: "programa indisponivel" });
      return;
    }
    res.writeHead(req.method === "HEAD" ? 200 : 200, {
      "content-type": "application/octet-stream",
      "content-length": file.size,
      "content-disposition": 'attachment; filename="SpartanLive.exe"',
      "cache-control": "no-store",
      ...GUARD,
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(file.path).pipe(res);
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && STATIC[pathname]) {
    const item = STATIC[pathname];
    const asset = staticAsset(item);
    const base = {
      "cache-control": item.cache,
      etag: asset.etag,
      vary: "Accept-Encoding",
      ...GUARD,
    };
    const tags = String(req.headers["if-none-match"] || "");
    const notModified = tags
      && (tags.trim() === "*" || tags.split(",").some((tag) => tag.trim() === asset.etag));
    if (notModified) {
      // Revalidar virou 304 de poucos bytes: o navegador não rebaixa 100 KB de app.js à toa.
      res.writeHead(304, base);
      res.end();
      return;
    }
    const coding = pickEncoding(req.headers["accept-encoding"], asset.compressible);
    const body = coding === "identity" ? asset.body : compressed(asset, coding);
    const headers = {
      ...base,
      "content-type": item.type,
      "content-length": body.length,
    };
    if (coding !== "identity") headers["content-encoding"] = coding;
    res.writeHead(200, headers);
    res.end(req.method === "HEAD" ? undefined : body);
    return;
  }

  sendJson(res, 404, { error: "nao encontrado" });
}

export function onRequest(req, res) {
  handle(req, res).catch((error) => {
    const offline = error?.cause?.code === "ECONNREFUSED" || error?.message === "fetch failed";
    const status = error.status || (offline ? 502 : 500);
    if (status >= 500) console.error(error.message || error);
    if (res.headersSent || res.writableEnded) return;
    sendJson(res, status, {
      error: status === 502 ? "O motor de vídeo não respondeu." : "Erro interno.",
    });
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (!VIEWER_USER || !SESSION_SECRET || !MTX_USER || !MTX_PASSWORD) {
    console.error("Faltam variaveis de ambiente do site.");
    process.exit(1);
  }
  const server = http.createServer(onRequest);
  server.requestTimeout = 120000;
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`spartan-live-site na porta ${PORT}`);
  });
}
