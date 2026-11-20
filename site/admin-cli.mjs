#!/usr/bin/env node
// Socorro pelo servidor, sem depender do site estar no ar para achar a senha.
// Roda dentro do container do site (é o mesmo users.json que o servidor lê):
//   ./admin-reset.sh list
//   ./admin-reset.sh link ana        -> link de primeiro acesso novo
//   ./admin-reset.sh add beto        -> cria conta (admin: add beto admin)
//   ./admin-reset.sh password ana    -> pergunta a senha nova no terminal
//   ./admin-reset.sh admin ana       -> promove a admin
//   ./admin-reset.sh delete ana
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  MAX_PASSWORD,
  MIN_PASSWORD,
  ROLE_ADMIN,
  ROLE_USER,
  adminCount,
  createUser,
  deleteUser,
  findUser,
  loadUsers,
  normalizeUserName,
  publicUser,
  resetUserPassword,
  saveUsers,
  setUserPassword,
} from "./users.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(HERE, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const LEGACY_FILE = path.join(DATA_DIR, "password.json");
const ADMIN_USER = process.env.VIEWER_USER || "spartan";

function usage() {
  console.log(`Uso: node admin-cli.mjs <comando>

  list                 mostra as contas
  link <usuario>       gera link de primeiro acesso novo (derruba a senha e as sessões)
  add <usuario> [admin] cria conta e mostra o link de primeiro acesso
  password <usuario>   define a senha na hora (lê do teclado)
  admin <usuario>      promove a admin
  delete <usuario>     exclui a conta

Arquivo de contas: ${USERS_FILE}`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function load() {
  const loaded = loadUsers(USERS_FILE, { adminUser: ADMIN_USER, legacyFile: LEGACY_FILE });
  if (loaded.initialPassword) {
    console.log(`Admin ${ADMIN_USER} criado agora. Senha inicial: ${loaded.initialPassword}`);
  }
  return loaded.store;
}

function nameArg(raw) {
  const name = normalizeUserName(raw || "");
  if (!name) fail("Informe o nome do usuário (2 a 24 letras minúsculas, números, _ ou -).");
  return name;
}

function ask(label) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(label, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function linkLine(token) {
  return `Link de primeiro acesso: /p/${token}\n` +
    "Abra no navegador com o endereço do site na frente (ex.: http://192.168.0.10:8097/p/...). Vale 7 dias e uma vez.";
}

const [command = "", ...rest] = process.argv.slice(2);

if (!command || command === "help" || command === "--help" || command === "-h") {
  usage();
  process.exit(0);
}

const store = load();

if (command === "list") {
  const users = store.users
    .map((user) => publicUser(user))
    .sort((a, b) => (a.role === b.role ? a.user.localeCompare(b.user) : a.role === ROLE_ADMIN ? -1 : 1));
  if (!users.length) fail("Nenhuma conta em " + USERS_FILE);
  for (const user of users) {
    const senha = user.hasPassword ? "senha" : "sem senha";
    const link = user.firstAccessUsable ? "  link pendente" : "";
    console.log(`${user.user}\t${user.role}\t${senha}${link}`);
  }
} else if (command === "link" || command === "reset") {
  const name = nameArg(rest[0]);
  const reset = resetUserPassword(store, name);
  if (reset.error) fail(reset.error);
  saveUsers(USERS_FILE, store);
  console.log(linkLine(reset.token));
} else if (command === "add") {
  const name = nameArg(rest[0]);
  const role = rest[1] === "admin" ? ROLE_ADMIN : ROLE_USER;
  const made = createUser(store, name, { role });
  if (made.error) fail(made.error);
  saveUsers(USERS_FILE, store);
  console.log(`Conta ${made.user.user} (${made.user.role}) criada.`);
  console.log(linkLine(made.token));
} else if (command === "password") {
  const name = nameArg(rest[0]);
  const plain = await ask(`Senha nova de ${name} (${MIN_PASSWORD} a ${MAX_PASSWORD} caracteres): `);
  const again = await ask("Repete a senha: ");
  if (plain !== again) fail("As duas senhas não estão iguais.");
  const saved = setUserPassword(store, name, plain);
  if (saved.error) fail(saved.error);
  saveUsers(USERS_FILE, store);
  console.log(`Senha de ${name} trocada. Os aparelhos que estavam logados caem no login.`);
} else if (command === "admin") {
  const name = nameArg(rest[0]);
  const user = findUser(store, name);
  if (!user) fail("usuário não encontrado");
  user.role = ROLE_ADMIN;
  saveUsers(USERS_FILE, store);
  console.log(`${name} agora é admin.`);
} else if (command === "delete") {
  const name = nameArg(rest[0]);
  const removed = deleteUser(store, name);
  if (removed.error) fail(removed.error);
  saveUsers(USERS_FILE, store);
  console.log(`Conta ${name} excluída. Admins restantes: ${adminCount(store)}.`);
} else {
  usage();
  process.exit(1);
}
