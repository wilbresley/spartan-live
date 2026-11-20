import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.VIEWER_USER = "spartan";
process.env.SESSION_SECRET = "teste-sessao";
process.env.MTX_USER = "site";
process.env.MTX_PASSWORD = "leitura";
// Senha de teste em pasta temporária: importar o server.mjs nunca deve criar
// arquivos dentro do repositório.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "spartan-auth-"));

const { ROLE_ADMIN, createUser, emptyStore, saveUsers, setUserPassword } = await import("./users.mjs");
const USERS_FILE = path.join(process.env.DATA_DIR, "users.json");

function seed(password) {
  const store = emptyStore();
  createUser(store, "spartan", { role: ROLE_ADMIN, now: 1 });
  setUserPassword(store, "spartan", password, 2);
  saveUsers(USERS_FILE, store);
}

seed("senha-de-teste");

const {
  makeTrustedProxies,
  passwordsMatch,
  pickClientIp,
  pickEncoding,
  readSession,
  reloadUsers,
  requestPath,
  safeHlsRest,
  safeHlsSearch,
  safeStreamName,
  signSession,
  thumbFile,
} = await import("./server.mjs");

test("senha confere sem vazar tamanho", () => {
  assert.equal(passwordsMatch("segredo", "segredo"), true);
  assert.equal(passwordsMatch("outra", "segredo"), false);
});

test("sessao assinada abre e expira", () => {
  const token = signSession("spartan", 1_000);
  assert.equal(readSession(token, 1_000).u, "spartan");
  assert.equal(readSession(token, 1_000 + 31 * 24 * 60 * 60 * 1000), null);
  assert.equal(readSession(`${token}x`, 1_000), null);
});

test("nome da live só aceita apelido simples", () => {
  assert.equal(safeStreamName("ana"), true);
  assert.equal(safeStreamName("ana_2"), true);
  assert.equal(safeStreamName("../etc"), false);
  assert.equal(safeStreamName("a b"), false);
  assert.equal(safeStreamName(""), false);
});

test("a thumb só aceita o nome da live", () => {
  assert.equal(thumbFile("../etc"), null);
  assert.equal(thumbFile("a b"), null);
  assert.equal(thumbFile("ana").endsWith("ana.jpg"), true);
});

test("compressão só quando o cliente aceita e nunca em imagem ou áudio", () => {
  assert.equal(pickEncoding("gzip, deflate", true), "gzip");
  assert.equal(pickEncoding("br, gzip", true), "br");
  assert.equal(pickEncoding("gzip;q=0", true), "identity");
  assert.equal(pickEncoding("br;q=0, gzip", true), "gzip");
  assert.equal(pickEncoding("", true), "identity");
  assert.equal(pickEncoding(undefined, true), "identity");
  assert.equal(pickEncoding("br, gzip", false), "identity");
});

test("caminho com pasta acima ou código quebrado não entra", () => {
  assert.equal(requestPath("/app.js"), "/app.js");
  assert.equal(requestPath("/hls/ana/../secret"), "");
  assert.equal(requestPath("/%"), "");
  assert.equal(safeHlsRest("index.m3u8"), true);
  assert.equal(safeHlsRest(".."), false);
  assert.equal(safeHlsRest("../mediamtx.yml"), false);
  assert.equal(safeHlsSearch("?x=1"), "?x=1");
  assert.equal(safeHlsSearch("?a=../b"), "");
});

test("trocar a senha derruba os cookies antigos", () => {
  const before = signSession("spartan", 1_000);
  assert.equal(readSession(before, 1_000)?.u, "spartan");

  seed("senha-nova-123");
  reloadUsers();
  assert.equal(readSession(before, 1_000), null, "cookie da senha antiga não abre mais");

  const after = signSession("spartan", 1_000);
  assert.equal(readSession(after, 1_000)?.u, "spartan");

  // Convite de convidado continua valendo: quem revoga é o guest.json.
  const guest = signSession("spartan", 1_000, { role: "guest", gid: "abc" });
  assert.equal(readSession(guest, 1_000)?.role, "guest");

  seed("senha-de-teste");
  reloadUsers();
});

test("só o gateway do container pode forjar X-Forwarded-For", () => {
  const trusted = makeTrustedProxies("", ["172.26.0.1"]);
  assert.equal(pickClientIp("172.26.0.1", "45.4.107.171", trusted), "45.4.107.171");
  // O cliente pode inventar o começo da lista; vale o último salto do proxy.
  assert.equal(pickClientIp("172.26.0.1", "1.2.3.4, 45.4.107.171", trusted), "45.4.107.171");
  // Máquina da LAN não é proxy: o header dela é ignorado.
  assert.equal(pickClientIp("192.168.100.10", "45.4.107.171", trusted), "192.168.100.10");
  // Outro container da mesma rede também não.
  assert.equal(pickClientIp("172.26.0.9", "45.4.107.171", trusted), "172.26.0.9");
  assert.equal(pickClientIp("::ffff:172.26.0.1", "45.4.107.171", trusted), "45.4.107.171");
  assert.equal(pickClientIp("172.26.0.1", "", trusted), "172.26.0.1");
  assert.equal(trusted("127.0.0.1"), true);
  assert.equal(trusted("172.26.1.1"), false, "só o gateway, não a /16 inteira");
});

test("com Cloudflare na frente o visitante real aparece", () => {
  const trusted = makeTrustedProxies("173.245.48.0/20", ["172.26.0.1"]);
  assert.equal(trusted("173.245.48.9"), true);
  assert.equal(trusted("173.245.63.255"), true);
  assert.equal(trusted("173.245.64.0"), false);
  assert.equal(pickClientIp("172.26.0.1", "45.4.107.171, 173.245.48.9", trusted), "45.4.107.171");
});
