import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hashPassword, loadPassword, passwordStamp, savePassword, verifyPassword } from "./password.mjs";

test("hash scrypt confere e não guarda a senha", () => {
  const record = hashPassword("spartanadmin");
  assert.equal(record.hash.includes("spartanadmin"), false);
  assert.equal(verifyPassword("spartanadmin", record), true);
  assert.equal(verifyPassword("outra", record), false);
});

test("arquivo novo nasce com a senha padrão e troca apaga a obrigação", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spartan-pass-"));
  const file = path.join(dir, "password.json");
  const created = loadPassword(file, "spartan");
  assert.equal(created.mustChange, true);
  assert.equal(created.user, "spartan");
  assert.equal(verifyPassword("spartanadmin", created), true);
  const changed = savePassword(file, "spartan", "senha-nova-123");
  assert.equal(changed.mustChange, false);
  assert.equal(verifyPassword("senha-nova-123", loadPassword(file, "spartan")), true);
  assert.equal(verifyPassword("spartanadmin", loadPassword(file, "spartan")), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

// A recuperação avisa no stderr de propósito; no teste o barulho não ajuda.
function quiet(fn) {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = warn;
  }
}

test("password.json corrompido é guardado de lado e não derruba o site", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spartan-pass-"));
  const file = path.join(dir, "password.json");
  fs.writeFileSync(file, "{ isto nao e json");
  const recovered = quiet(() => loadPassword(file, "spartan"));
  assert.equal(recovered.mustChange, true, "volta pedindo troca de senha");
  assert.equal(verifyPassword("spartanadmin", recovered), true);
  assert.equal(fs.existsSync(file), true, "um arquivo novo nasce no lugar");
  const backups = fs.readdirSync(dir).filter((name) => name.startsWith("password.json.corrupt-"));
  assert.equal(backups.length, 1, "o arquivo quebrado fica guardado");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("registro sem hash também é recuperado", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spartan-pass-"));
  const file = path.join(dir, "password.json");
  fs.writeFileSync(file, JSON.stringify({ user: "spartan", mustChange: false }));
  const recovered = quiet(() => loadPassword(file, "spartan"));
  assert.equal(recovered.mustChange, true);
  assert.equal(verifyPassword("qualquer-coisa", recovered), false);
  assert.equal(verifyPassword("spartanadmin", recovered), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a marca da senha muda a cada troca", () => {
  const first = passwordStamp(hashPassword("mesma-senha"));
  const second = passwordStamp(hashPassword("mesma-senha"));
  assert.equal(first.length, 16);
  assert.notEqual(first, second);
  assert.equal(passwordStamp(null), "");
  assert.equal(passwordStamp({ salt: "x" }), "");
});
