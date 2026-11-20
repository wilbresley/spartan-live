import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("./admin-cli.mjs", import.meta.url));

function dataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "spartan-cli-"));
}

function runWithEnv(dir, env, ...args) {
  return execFileSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, DATA_DIR: dir, VIEWER_USER: "spartan", SITE_URL: "", ...env },
    encoding: "utf8",
  });
}

function run(dir, ...args) {
  return runWithEnv(dir, {}, ...args);
}

test("sem users.json o cli cria o admin e mostra a senha inicial uma vez", () => {
  const dir = dataDir();
  const out = run(dir, "list");
  assert.match(out, /Admin spartan criado agora\. Senha inicial: [0-9a-f]{18}/);
  assert.match(out, /spartan\tadmin\tsenha/);

  const raw = JSON.parse(fs.readFileSync(path.join(dir, "users.json"), "utf8"));
  assert.equal(raw.users.length, 1);
  assert.equal(raw.users[0].role, "admin");
  assert.equal(raw.users[0].mustChange, true);

  const again = run(dir, "list");
  assert.equal(again.includes("Senha inicial"), false, "a senha não se repete");
});

test("add já devolve link de primeiro acesso e link renova o convite", () => {
  const dir = dataDir();
  run(dir, "list");
  const created = run(dir, "add", "Ana");
  assert.match(created, /Conta ana \(user\) criada\./);
  const first = created.match(/\/p\/([A-Za-z0-9_-]{16,64})/);
  assert.ok(first, "veio o caminho /p/...");

  const renewed = run(dir, "link", "ana");
  const second = renewed.match(/\/p\/([A-Za-z0-9_-]{16,64})/);
  assert.ok(second);
  assert.notEqual(second[1], first[1], "link novo é outro");

  const store = JSON.parse(fs.readFileSync(path.join(dir, "users.json"), "utf8"));
  const ana = store.users.find((user) => user.user === "ana");
  assert.equal(ana.hash, undefined, "link pendente deixa a conta sem senha");
  assert.ok(ana.first && ana.first.hash, "token guardado só como hash");
  assert.equal(JSON.stringify(store).includes(first[1]), false, "token não fica em texto puro");
});

test("com SITE_URL o cli imprime a mensagem pronta com o link completo", () => {
  const dir = dataDir();
  run(dir, "list");
  const created = runWithEnv(dir, { SITE_URL: "https://live.exemplo.com/" }, "add", "ana");
  assert.match(created, /Mensagem pra mandar no WhatsApp:/);
  assert.match(created, /Ana, seu acesso do Spartan Live: https:\/\/live\.exemplo\.com\/p\/[A-Za-z0-9_-]{16,64}/);
  assert.match(created, /Login: ana — a senha você define no link\. Vale 7 dias, uma vez só\. Site: https:\/\/live\.exemplo\.com/);
  assert.equal(created.includes("192.168.0.10"), false, "sem endereço de exemplo furado");

  const renewed = run(dir, "link", "ana");
  assert.match(renewed, /Link de primeiro acesso: \/p\/[A-Za-z0-9_-]{16,64}/);
  assert.match(renewed, /preencha SITE_URL no \.env/);
  assert.match(run(dir, "help"), /Endereço público: \(preencha SITE_URL no \.env/);
});

test("promover e excluir respeitam o último admin", () => {
  const dir = dataDir();
  run(dir, "list");
  run(dir, "add", "ana");
  const promoted = run(dir, "admin", "ana");
  assert.match(promoted, /ana agora é admin\./);

  const removed = run(dir, "delete", "ana");
  assert.match(removed, /Conta ana excluída\. Admins restantes: 1\./);

  assert.throws(
    () => run(dir, "delete", "spartan"),
    (error) => String(error.stderr).includes("O último admin não pode ser excluído."),
  );
});

test("nome inválido e usuário inexistente saem com erro", () => {
  const dir = dataDir();
  run(dir, "list");
  assert.throws(() => run(dir, "add", "A"), (error) => String(error.stderr).includes("O nome precisa ter"));
  assert.throws(
    () => run(dir, "link", "fantasma"),
    (error) => String(error.stderr).includes("usuário não encontrado"),
  );
});
