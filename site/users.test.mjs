import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  FIRST_ACCESS_TTL_MS,
  ROLE_ADMIN,
  ROLE_USER,
  checkPassword,
  createUser,
  deleteUser,
  emptyStore,
  findFirstAccess,
  firstAccessPath,
  loadUsers,
  publicUser,
  publishAllowed,
  redeemFirstAccess,
  resetUserPassword,
  saveUsers,
  setUserPassword,
  userStamp,
  validUserName,
  verifyUserLogin,
} from "./users.mjs";
import { hashPassword } from "./password.mjs";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "spartan-users-"));
}

function quiet(fn) {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = warn;
  }
}

function storeWithAdmin() {
  const store = emptyStore();
  const made = createUser(store, "spartan", { role: ROLE_ADMIN, now: 1_000 });
  setUserPassword(made.store, "spartan", "senha-do-admin", 2_000);
  return made.store;
}

test("nome de usuário é o apelido: minúsculo, 2 a 24, sem espaço", () => {
  assert.equal(validUserName("spartan"), true);
  assert.equal(validUserName("ana_2"), true);
  assert.equal(validUserName("jardel-x"), true);
  assert.equal(validUserName("Ana"), true, "maiúscula é normalizada");
  assert.equal(validUserName("a"), false);
  assert.equal(validUserName("a b"), false);
  assert.equal(validUserName("../etc"), false);
  assert.equal(validUserName("x".repeat(25)), false);
});

test("usuário criado nasce sem senha e não entra até usar o link", () => {
  const store = storeWithAdmin();
  const made = createUser(store, "jardel", { now: 10_000 });
  assert.ok(made.token.length >= 32);
  assert.equal(made.user.user, "jardel");
  assert.equal(made.user.role, ROLE_USER);
  assert.equal(made.user.hash, undefined);
  assert.equal(verifyUserLogin(store, "jardel", "qualquer-senha", 10_000).ok, false);
  assert.equal(publishAllowed(store, "jardel", "qualquer-senha"), false);
  assert.equal(findFirstAccess(store, made.token, 10_000)?.user, "jardel");
  assert.equal(firstAccessPath(made.token), `/p/${made.token}`);
});

test("o link de primeiro acesso define a senha e só serve uma vez", () => {
  const store = storeWithAdmin();
  const made = createUser(store, "jardel", { now: 10_000 });
  const redeem = redeemFirstAccess(store, made.token, "senha-boa-123", 11_000);
  assert.equal(redeem.error, undefined);
  assert.equal(redeem.user.user, "jardel");
  assert.equal(verifyUserLogin(store, "jardel", "senha-boa-123", 12_000).ok, true);
  assert.equal(findFirstAccess(store, made.token, 12_000), null, "token usado não volta");
  const again = redeemFirstAccess(store, made.token, "outra-senha-123", 13_000);
  assert.equal(again.error !== undefined, true);
  assert.equal(publishAllowed(store, "jardel", "senha-boa-123"), true);
});

test("link vencido ou inventado não define senha", () => {
  const store = storeWithAdmin();
  const made = createUser(store, "jardel", { now: 10_000 });
  assert.equal(findFirstAccess(store, made.token, 10_000 + FIRST_ACCESS_TTL_MS), null);
  assert.equal(redeemFirstAccess(store, "x".repeat(43), "senha-boa-123", 10_000).error !== undefined, true);
  assert.equal(redeemFirstAccess(store, "", "senha-boa-123", 10_000).error !== undefined, true);
});

test("senha fraca não passa e a senha não pode ser o nome do usuário", () => {
  assert.match(checkPassword("jardelzinho", "curta"), /8 caracteres/);
  assert.match(checkPassword("jardelzinho", "jardelzinho"), /nome de usuário/);
  assert.match(checkPassword("jardel", "Mudar@123"), /fácil de adivinhar/);
  assert.equal(checkPassword("jardel", "senha-boa-123"), "");
  const store = storeWithAdmin();
  const made = createUser(store, "jardel", { now: 1_000 });
  const weak = redeemFirstAccess(store, made.token, "Mudar@123", 2_000);
  assert.equal(weak.status, 400);
  assert.equal(weak.user, undefined);
});

test("redefinir apaga a senha antiga, mata a marca e emite link novo", () => {
  const store = storeWithAdmin();
  const made = createUser(store, "jardel", { now: 1_000 });
  redeemFirstAccess(store, made.token, "senha-velha-123", 2_000);
  const before = userStamp(store.users.find((item) => item.user === "jardel"));
  assert.equal(verifyUserLogin(store, "jardel", "senha-velha-123", 3_000).ok, true);

  const reset = resetUserPassword(store, "jardel", { now: 4_000 });
  assert.equal(reset.error, undefined);
  assert.ok(reset.token.length >= 32);
  assert.equal(verifyUserLogin(store, "jardel", "senha-velha-123", 5_000).ok, false);
  assert.equal(publishAllowed(store, "jardel", "senha-velha-123"), false);
  assert.equal(userStamp(reset.user), "", "sem hash não existe marca de sessão");
  assert.notEqual(userStamp(reset.user), before);
  assert.equal(findFirstAccess(store, reset.token, 5_000)?.user, "jardel");
});

test("excluir usuário funciona, mas o último admin não sai", () => {
  const store = storeWithAdmin();
  createUser(store, "jardel", { now: 1_000 });
  assert.equal(deleteUser(store, "jardel").removed.user, "jardel");
  assert.equal(store.users.length, 1);
  const blocked = deleteUser(store, "spartan");
  assert.equal(blocked.status, 409);
  assert.equal(blocked.removed, undefined);
  assert.equal(deleteUser(store, "ninguem").status, 404);
});

test("a projeção pública não vaza hash, salt nem token", () => {
  const store = storeWithAdmin();
  const made = createUser(store, "jardel", { now: 1_000 });
  const seen = publicUser(made.user, 2_000);
  const text = JSON.stringify(seen);
  assert.equal(text.includes("salt"), false);
  assert.equal(text.includes("hash"), false);
  assert.equal(text.includes(made.token), false);
  assert.equal(seen.hasPassword, false);
  assert.equal(seen.firstAccessUsable, true);
  assert.equal(JSON.stringify(publicUser(store.users[0], 2_000)).includes("senha-do-admin"), false);
});

test("salvar e ler de novo mantém senha e papel", () => {
  const dir = tempDir();
  const file = path.join(dir, "users.json");
  const store = storeWithAdmin();
  const made = createUser(store, "jardel", { now: 1_000 });
  redeemFirstAccess(store, made.token, "senha-boa-123", 2_000);
  saveUsers(file, store);

  const again = loadUsers(file, { adminUser: "spartan" });
  assert.equal(again.initialPassword, "");
  assert.equal(again.store.users.length, 2);
  assert.equal(verifyUserLogin(again.store, "jardel", "senha-boa-123", 3_000).ok, true);
  assert.equal(findUserRole(again.store, "spartan"), ROLE_ADMIN);
  fs.rmSync(dir, { recursive: true, force: true });
});

function findUserRole(store, name) {
  return store.users.find((item) => item.user === name)?.role;
}

test("instalação nova nasce com admin e senha aleatória mostrada uma vez", () => {
  const dir = tempDir();
  const file = path.join(dir, "users.json");
  const first = loadUsers(file, { adminUser: "spartan" });
  assert.match(first.initialPassword, /^[0-9a-f]{18}$/);
  assert.equal(first.store.users.length, 1);
  assert.equal(findUserRole(first.store, "spartan"), ROLE_ADMIN);
  assert.equal(verifyUserLogin(first.store, "spartan", first.initialPassword, 1).ok, true);

  const second = loadUsers(file, { adminUser: "spartan" });
  assert.equal(second.initialPassword, "", "a senha inicial não é reimpressa");
  assert.equal(verifyUserLogin(second.store, "spartan", first.initialPassword, 2).ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("instalação antiga herda a senha do password.json", () => {
  const dir = tempDir();
  const file = path.join(dir, "users.json");
  const legacy = path.join(dir, "password.json");
  fs.writeFileSync(legacy, JSON.stringify({ user: "spartan", ...hashPassword("senha-do-dono"), mustChange: true }));
  const loaded = loadUsers(file, { adminUser: "spartan", legacyFile: legacy });
  assert.equal(loaded.initialPassword, "");
  assert.equal(findUserRole(loaded.store, "spartan"), ROLE_ADMIN);
  assert.equal(verifyUserLogin(loaded.store, "spartan", "senha-do-dono", 1).ok, true);
  assert.equal(loaded.store.users[0].mustChange, true, "o gate de troca continua");
  assert.equal(fs.existsSync(file), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("users.json corrompido é guardado de lado e a lista é recriada", () => {
  const dir = tempDir();
  const file = path.join(dir, "users.json");
  fs.writeFileSync(file, "{ isso nao e json");
  const loaded = quiet(() => loadUsers(file, { adminUser: "spartan" }));
  assert.equal(loaded.store.users.length, 1);
  assert.equal(findUserRole(loaded.store, "spartan"), ROLE_ADMIN);
  const backups = fs.readdirSync(dir).filter((name) => name.startsWith("users.json.corrupt-"));
  assert.equal(backups.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("lista sem admin promove o usuário mais antigo em vez de apagar", () => {
  const dir = tempDir();
  const file = path.join(dir, "users.json");
  const store = emptyStore();
  store.users.push({ user: "jardel", role: ROLE_USER, createdAt: 10, mustChange: false });
  store.users.push({ user: "ana", role: ROLE_USER, createdAt: 20, mustChange: false });
  fs.writeFileSync(file, JSON.stringify(store));
  const loaded = loadUsers(file, { adminUser: "spartan" });
  assert.equal(loaded.store.users.length, 2, "ninguém é jogado fora");
  assert.equal(findUserRole(loaded.store, "jardel"), ROLE_ADMIN);
  assert.equal(findUserRole(loaded.store, "ana"), ROLE_USER);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a marca do usuário muda quando ele troca a senha", () => {
  const store = storeWithAdmin();
  const first = userStamp(store.users[0]);
  setUserPassword(store, "spartan", "outra-senha-123", 9_000);
  const second = userStamp(store.users[0]);
  assert.equal(first.length, 16);
  assert.notEqual(first, second);
  assert.equal(userStamp(null), "");
});

