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

export function loadPassword(file, user = "spartan") {
  if (fs.existsSync(file)) {
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    record.user = record.user || user;
    return record;
  }
  const record = { user, ...hashPassword("spartanadmin"), mustChange: true };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* o volume do Windows não aceita esse modo */
  }
  return record;
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
