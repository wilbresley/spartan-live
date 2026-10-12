import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hashPassword, loadPassword, savePassword, verifyPassword } from "./password.mjs";

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
