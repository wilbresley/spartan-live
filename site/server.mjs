import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { loadPassword, savePassword, verifyPassword } from "./password.mjs";
import { countViewers, dropViewer, touchViewer, SAD_GIFS } from "./public/theater.mjs";
import {
  createGuest,
  createPermanentGuest,
  findGuestInvite,
  guestEndMessage,
  normalizeGuestStore,
  PERMANENT_SESSION_MS,
} from "./public/guest-link.mjs";

const PORT = Number(process.env.PORT || 8080);
const VIEWER_USER = process.env.VIEWER_USER || "";
const VIEWER_PASSWORD = process.env.VIEWER_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const MTX_API_URL = (process.env.MTX_API_URL || "http://spartan-live-motor:9997").replace(/\/$/, "");
const MTX_HLS_URL = (process.env.MTX_HLS_URL || "http://spartan-live-motor:8888").replace(/\/$/, "");
const MTX_USER = process.env.MTX_USER || "";
const MTX_PASSWORD = process.env.MTX_PASSWORD || "";
const PUBLISH_USER = process.env.PUBLISH_USER || "";
const PUBLISH_PASSWORD = process.env.PUBLISH_PASSWORD || "";

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
const shareByStream = new Map();
let passwordRecord = null;

function viewerRecord() {
  if (!passwordRecord) passwordRecord = loadPassword(PASSWORD_FILE, VIEWER_USER || "spartan");
  return passwordRecord;
}

function loadGuestStore(now = Date.now()) {
  try {
    return normalizeGuestStore(JSON.parse(fs.readFileSync(GUEST_FILE, "utf8")), now);
  } catch {
    return { temporary: null, permanent: null };
  }
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
}

function openSession(req, now = Date.now()) {
  const data = readSession(cookies(req)[COOKIE], now);
  if (!data) return { session: null, guestEnded: false, guestEnd: "" };
  if (data.role !== "guest") return { session: data, guestEnded: false, guestEnd: "" };
  const found = findGuestInvite(loadGuestStore(now), data.gid, now);
  if (found && data.exp >= now) {
    return { session: { ...data, kind: found.kind }, guestEnded: false, guestEnd: "" };
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

function shareFlags(name) {
  const mark = shareByStream.get(name);
  if (!mark) return { guestsTemp: false, guestsPerm: false };
  return {
    guestsTemp: Boolean(mark.guestsTemp),
    guestsPerm: Boolean(mark.guestsPerm),
  };
}

function guestMaySee(session, name) {
  if (!session || session.role !== "guest") return true;
  const flags = shareFlags(name);
  if (session.kind === "permanent") return flags.guestsPerm;
  return flags.guestsTemp;
}

function publisherAllowed(body) {
  if (!PUBLISH_USER || !PUBLISH_PASSWORD) return false;
  return passwordsMatch(String(body.user || ""), PUBLISH_USER) && passwordsMatch(String(body.password || ""), PUBLISH_PASSWORD);
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
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8", cache: "no-cache" },
  "/entrar.mp3": { file: "entrar.mp3", type: "audio/mpeg", cache: "public, max-age=86400" },
  "/sair.mp3": { file: "sair.mp3", type: "audio/mpeg", cache: "public, max-age=86400" },
  "/spartan-live.png": { file: "spartan-live.png", type: "image/png", cache: "public, max-age=86400" },
  "/play.png": { file: "play.png", type: "image/png", cache: "no-cache" },
  "/pause.png": { file: "pause.png", type: "image/png", cache: "no-cache" },
  "/empty-sad.gif": { file: "empty-sad.gif", type: "image/gif", cache: "public, max-age=86400" },
  ...Object.fromEntries(
    Array.from({ length: 12 }, (_, idx) => [
      `/gifs/sad-${idx + 1}.gif`,
      { file: `gifs/sad-${idx + 1}.gif`, type: "image/gif", cache: "public, max-age=86400" },
    ])
  ),
  ...Object.fromEntries(
    Array.from({ length: 12 }, (_, idx) => [
      `/gifs/happy-${idx + 1}.gif`,
      { file: `gifs/happy-${idx + 1}.gif`, type: "image/gif", cache: "public, max-age=86400" },
    ])
  ),
  "/hls.min.js": { file: "hls.min.js", type: "text/javascript; charset=utf-8", cache: "public, max-age=86400" },
};

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
    if (typeof extra.exp === "number") payload.exp = extra.exp;
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
    if (!data || data.u !== VIEWER_USER || typeof data.exp !== "number") return null;
    if (data.exp < now && data.role !== "guest") return null;
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
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function clientIp(req) {
  const remote = String(req.socket.remoteAddress || "");
  const forwarded = req.headers["x-forwarded-for"];
  if (trustedProxy(remote) && typeof forwarded === "string" && forwarded.length > 0 && forwarded.length < 200) {
    return forwarded.split(",")[0].trim().slice(0, 64) || remote || "local";
  }
  return remote || "local";
}

function watcherKey(req, guest, kind = "") {
  const who = guest ? (kind === "permanent" ? "gp" : "g") : "o";
  const agent = String(req.headers["user-agent"] || "").slice(0, 64);
  return `${who}|${clientIp(req)}|${agent}`;
}

function trustedProxy(remote) {
  const ip = remote.replace(/^::ffff:/, "");
  if (ip === "127.0.0.1" || ip === "::1") return true;
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  if (parts[0] === 10) return true;
  return parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31;
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
  const https = req.headers["x-forwarded-proto"] === "https" || req.socket.encrypted;
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
  const state = fails.get(ip) || { count: 0, until: 0 };
  if (Date.now() < state.until) {
    sendJson(res, 429, { error: "Espera um pouco e tenta de novo." });
    return;
  }

  const body = await readJson(req);
  const record = viewerRecord();
  const userOk = passwordsMatch(body.user || "", record.user || VIEWER_USER);
  const passOk = verifyPassword(body.password || "", record);
  if (!userOk || !passOk) {
    state.count += 1;
    if (state.count >= 8) {
      state.until = Date.now() + 5 * 60 * 1000;
      state.count = 0;
    }
    fails.set(ip, state);
    sendJson(res, 401, { error: "Nome ou senha não confere." });
    return;
  }

  fails.delete(ip);
  sendJson(res, 200, { ok: true, mustChange: Boolean(record.mustChange) }, {
    "set-cookie": cookieHeader(signSession(record.user || VIEWER_USER), req),
  });
}

async function listStreams() {
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

async function proxyHls(req, res, name, rest, search) {
  const target = `${MTX_HLS_URL}/${encodeURIComponent(name)}/${rest}${search}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  req.socket.on("close", () => controller.abort());
  let upstream;
  try {
    upstream = await fetch(target, {
      headers: { authorization: mtxAuthorization() },
      signal: controller.signal,
    });
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
  if (!publisherAllowed({ user, password }) || !safeStreamName(name)) {
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
  if (!PUBLISH_USER || !PUBLISH_PASSWORD) {
    sendJson(res, 503, { error: "parada manual indisponivel" });
    return;
  }
  if (!publisherAllowed(body) || !safeStreamName(name)) {
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
  if (!publisherAllowed(body) || !safeStreamName(name)) {
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
  if (!publisherAllowed(body) || !safeStreamName(name)) {
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
  const state = fails.get(ip) || { count: 0, until: 0 };
  if (Date.now() < state.until) {
    sendJson(res, 429, { error: "Espera um pouco e tenta de novo." });
    return;
  }
  const body = await readJson(req);
  const current = String(body.current || "");
  const next = String(body.next || "");
  const again = String(body.again || "");
  const record = viewerRecord();
  if (!verifyPassword(current, record)) {
    state.count += 1;
    if (state.count >= 8) {
      state.until = Date.now() + 5 * 60 * 1000;
      state.count = 0;
    }
    fails.set(ip, state);
    sendJson(res, 401, { error: "A senha atual não confere." });
    return;
  }
  if (next.length < 8 || next.length > 128) {
    sendJson(res, 400, { error: "A nova senha precisa ter pelo menos 8 caracteres." });
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
  passwordRecord = savePassword(PASSWORD_FILE, record.user || VIEWER_USER || "spartan", next);
  sendJson(res, 200, { ok: true });
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

  if (req.method === "POST" && pathname === "/api/login") {
    await handleLogin(req, res);
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
    if (!publisherAllowed(body) || !safeStreamName(name)) {
      sendJson(res, 401, { error: "nao autorizado" });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      viewers: countViewers(viewersByStream, name),
      guests: countViewers(guestsByStream, name),
      permanent: countViewers(permanentGuestsByStream, name),
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/share") {
    const body = await readJson(req);
    const name = String(body.name || "");
    if (!publisherAllowed(body) || !safeStreamName(name)) {
      sendJson(res, 401, { error: "nao autorizado" });
      return;
    }
    shareByStream.set(name, {
      guestsTemp: Boolean(body.guestsTemp),
      guestsPerm: Boolean(body.guestsPerm),
      at: Date.now(),
    });
    sendJson(res, 200, { ok: true });
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
    if (guest || !viewerRecord().mustChange) return false;
    sendJson(res, 403, { error: "Troque a senha antes de entrar.", mustChange: true });
    return true;
  }

  if (req.method === "GET" && pathname === "/api/me") {
    if (needsLogin()) return;
    sendJson(res, 200, {
      user: session.u,
      role: guest ? "guest" : "owner",
      kind: guest ? (session.kind || "temporary") : "",
      mustChange: guest ? false : Boolean(viewerRecord().mustChange),
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
      if (body.permanent) {
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
    const names = Array.isArray(body.names) ? body.names : [];
    const kind = guest ? (session.kind || "temporary") : "";
    const viewerKey = watcherKey(req, guest, kind);
    const now = Date.now();
    const book = !guest
      ? viewersByStream
      : (kind === "permanent" ? permanentGuestsByStream : guestsByStream);
    for (const raw of names) {
      const name = String(raw || "");
      if (safeStreamName(name) && guestMaySee(session, name)) touchViewer(book, name, viewerKey, now);
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && pathname === "/api/unwatch") {
    if (needsLogin()) return;
    const body = await readJson(req);
    const name = String(body.name || "");
    if (safeStreamName(name)) {
      const kind = guest ? (session.kind || "temporary") : "";
      const viewerKey = watcherKey(req, guest, kind);
      dropViewer(viewersByStream, name, viewerKey);
      dropViewer(guestsByStream, name, viewerKey);
      dropViewer(permanentGuestsByStream, name, viewerKey);
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && pathname === "/api/streams") {
    if (needsLogin() || ownerLocked()) return;
    const live = await listStreams();
    const stopped = currentStopped(live);
    const gone = new Set(stopped);
    const now = Date.now();
    const streams = live
      .filter((stream) => !gone.has(stream.name) && guestMaySee(session, stream.name))
      .map((stream) => ({
        ...stream,
        thumbAt: thumbStamp(stream.name),
        viewers: countViewers(viewersByStream, stream.name, now),
        guests: countViewers(guestsByStream, stream.name, now),
        permanent: countViewers(permanentGuestsByStream, stream.name, now),
      }));
    const switching = collectSwitching(switchingUntil, streams).filter((name) => guestMaySee(session, name));
    const switchingKinds = collectSwitchKinds(switchingUntil);
    sweepThumbs(streams.map((stream) => stream.name), switching);
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
    if (viewerRecord().mustChange) {
      sendJson(res, 403, { error: "Troque a senha antes de entrar.", mustChange: true });
      return;
    }
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

  if (req.method === "GET" && STATIC[pathname]) {
    const item = STATIC[pathname];
    const filePath = path.join(PUBLIC_DIR, item.file);
    const body = fs.readFileSync(filePath);
    res.writeHead(200, {
      "content-type": item.type,
      "cache-control": item.cache,
      ...GUARD,
    });
    res.end(body);
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
