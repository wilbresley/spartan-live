import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const KEY_BYTES = 64;

export function hashPassword(plain, salt = crypto.randomBytes(16)) {
  const params = { N: 16384, r: 8, p: 1 };
  const hash = crypto.scryptSync(String(plain), salt, KEY_BYTES, params);
  return {
    salt: salt.toString("base64url"),
    hash: hash.toString("base64url"),
    n: params.N,
    r: params.r,
    p: params.p,
  };
}

export function verifyPassword(plain, record) {
  if (!record?.salt || !record?.hash) return false;
  const salt = Buffer.from(record.salt, "base64url");
  const expected = Buffer.from(record.hash, "base64url");
  const actual = crypto.scryptSync(String(plain), salt, expected.length, {
    N: Number(record.n) || 16384,
    r: Number(record.r) || 8,
    p: Number(record.p) || 1,
  });
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

// Impressão digital do registro (muda a cada troca de senha, mesmo com o mesmo
// texto). O cookie de sessão carrega essa marca, então senha trocada derruba
// todos os cookies emitidos antes.
export function passwordStamp(record) {
  if (!record?.salt || !record?.hash) return "";
  return crypto.createHash("sha256").update(`${record.salt}:${record.hash}`).digest("base64url").slice(0, 16);
}

function looksLikeHash(record) {
  if (!record || typeof record !== "object") return false;
  if (typeof record.salt !== "string" || typeof record.hash !== "string") return false;
  return Buffer.from(record.salt, "base64url").length >= 8
    && Buffer.from(record.hash, "base64url").length >= 16;
}

function writeRecord(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* o volume do Windows não aceita esse modo */
  }
  return record;
}

// Guarda o arquivo ruim de lado antes de recriar: se ele quebrou por corrupção do
// disco, o original fica para investigar.
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

export function loadPassword(file, user = "spartan") {
  if (fs.existsSync(file)) {
    let record = null;
    try {
      record = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      record = null;
    }
    // Arquivo quebrado (JSON inválido, truncado, sem hash) travava o site inteiro:
    // loadPassword estourava e todo pedido virava 500. Agora ele é posto de lado e
    // nasce um novo com a senha padrão e a troca obrigatória.
    if (!looksLikeHash(record)) {
      const backup = quarantine(file);
      console.warn(
        `password.json invalido${backup ? ` (guardado em ${path.basename(backup)})` : ""}; recriando a senha padrao.`,
      );
      return writeRecord(file, { user, ...hashPassword("spartanadmin"), mustChange: true });
    }
    record.user = record.user || user;
    return record;
  }
  return writeRecord(file, { user, ...hashPassword("spartanadmin"), mustChange: true });
}

export function savePassword(file, user, plain) {
  const record = { user, ...hashPassword(plain), mustChange: false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(temp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* o volume do Windows não aceita esse modo */
  }
  return record;
}
