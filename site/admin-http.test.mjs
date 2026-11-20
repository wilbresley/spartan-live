import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "spartan-admin-"));
process.env.VIEWER_USER = "spartan";
process.env.SESSION_SECRET = "teste-sessao";
process.env.MTX_USER = "site";
process.env.MTX_PASSWORD = "leitura";
process.env.MTX_AUTH_SECRET = "segredo-do-motor";
process.env.DATA_DIR = dataDir;

const { ROLE_ADMIN, createUser, emptyStore, saveUsers, setUserPassword } = await import("./users.mjs");
const USERS_FILE = path.join(dataDir, "users.json");

function seedAdmin(password) {
  const store = emptyStore();
  createUser(store, "spartan", { role: ROLE_ADMIN, now: 1 });
  setUserPassword(store, "spartan", password, 2);
  saveUsers(USERS_FILE, store);
}

seedAdmin("senha-do-admin");

const { onRequest } = await import("./server.mjs");

function listen() {
  const server = http.createServer(onRequest);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function ask(server, { method = "GET", path: target = "/", cookie = "", body = "" } = {}) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      method,
      path: target,
      headers: {
        cookie,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(raw); } catch { /* html */ }
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

function cookieOf(headers) {
  const raw = headers["set-cookie"];
  const line = Array.isArray(raw) ? raw[0] : raw;
  return String(line || "").split(";")[0];
}

async function login(server, user, password) {
  const res = await ask(server, {
    method: "POST",
    path: "/api/login",
    body: JSON.stringify({ user, password }),
  });
  return { status: res.status, json: res.json, cookie: cookieOf(res.headers) };
}

async function mtxAuth(server, body, secret = "segredo-do-motor") {
  return ask(server, {
    method: "POST",
    path: `/api/mtx-auth?secret=${encodeURIComponent(secret)}`,
    body: JSON.stringify(body),
  });
}

test("admin cria usuario, o link abre a pagina e o primeiro acesso entra no site", async () => {
  const server = await listen();
  try {
    const admin = await login(server, "spartan", "senha-do-admin");
    assert.equal(admin.status, 200);
    assert.equal(admin.json.role, "admin");

    const made = await ask(server, {
      method: "POST",
      path: "/api/admin/users",
      cookie: admin.cookie,
      body: JSON.stringify({ user: "Jardel" }),
    });
    assert.equal(made.status, 200);
    assert.equal(made.json.user.user, "jardel", "nome normalizado");
    assert.equal(made.json.user.hasPassword, false);
    assert.match(made.json.path, /^\/p\/[\w-]{16,64}$/);

    const page = await ask(server, { path: made.json.path });
    assert.equal(page.status, 200);
    assert.match(page.raw, /Primeiro acesso/);
    assert.match(page.raw, /jardel/);
    assert.equal(page.headers["cache-control"], "no-store");

    const token = made.json.path.slice(3);
    const info = await ask(server, { path: `/api/first-access?t=${token}` });
    assert.equal(info.status, 200);
    assert.equal(info.json.user, "jardel");

    const weak = await ask(server, {
      method: "POST",
      path: "/api/first-access",
      body: JSON.stringify({ t: token, password: "curta", again: "curta" }),
    });
    assert.equal(weak.status, 400);

    const done = await ask(server, {
      method: "POST",
      path: "/api/first-access",
      body: JSON.stringify({ t: token, password: "senha-do-jardel", again: "senha-do-jardel" }),
    });
    assert.equal(done.status, 200);
    assert.equal(done.json.user, "jardel");
    const userCookie = cookieOf(done.headers);
    assert.match(userCookie, /^spartan_live=/);

    const me = await ask(server, { path: "/api/me", cookie: userCookie });
    assert.equal(me.status, 200);
    assert.equal(me.json.user, "jardel");
    assert.equal(me.json.role, "user");
    assert.equal(me.json.mustChange, false);

    const again = await ask(server, { path: made.json.path });
    assert.equal(again.status, 410, "link vale uma vez so");
    assert.equal((await ask(server, { path: `/api/first-access?t=${token}` })).status, 410);
  } finally {
    server.close();
  }
});

test("usuario comum nao administra e a lista nao devolve hash nem token", async () => {
  const server = await listen();
  try {
    const admin = await login(server, "spartan", "senha-do-admin");
    const user = await login(server, "jardel", "senha-do-jardel");
    assert.equal(user.status, 200);

    const denied = await ask(server, { path: "/api/admin/users", cookie: user.cookie });
    assert.equal(denied.status, 403);
    const deniedPost = await ask(server, {
      method: "POST",
      path: "/api/admin/users",
      cookie: user.cookie,
      body: JSON.stringify({ user: "invasor" }),
    });
    assert.equal(deniedPost.status, 403);

    const list = await ask(server, { path: "/api/admin/users", cookie: admin.cookie });
    assert.equal(list.status, 200);
    assert.equal(list.json.users.length, 2);
    assert.equal(list.json.users[0].role, "admin", "admin vem primeiro");
    const text = JSON.stringify(list.json);
    assert.equal(text.includes("salt"), false);
    assert.equal(text.includes("hash"), false);
    assert.equal(text.includes("senha-do-jardel"), false);

    assert.equal((await ask(server, { path: "/api/admin/users" })).status, 401, "sem sessao nao lista");
  } finally {
    server.close();
  }
});



test("redefinir derruba a sessao e a transmissao na hora e emite link novo", async () => {
  const server = await listen();
  try {
    const admin = await login(server, "spartan", "senha-do-admin");
    const made = await ask(server, {
      method: "POST",
      path: "/api/admin/users",
      cookie: admin.cookie,
      body: JSON.stringify({ user: "ana" }),
    });
    const token = made.json.path.slice(3);
    await ask(server, {
      method: "POST",
      path: "/api/first-access",
      body: JSON.stringify({ t: token, password: "senha-da-ana", again: "senha-da-ana" }),
    });
    const ana = await login(server, "ana", "senha-da-ana");
    assert.equal(ana.status, 200);
    assert.equal((await ask(server, { path: "/api/me", cookie: ana.cookie })).status, 200);
    assert.equal(
      (await mtxAuth(server, { action: "publish", user: "ana", password: "senha-da-ana", path: "ana" })).status,
      200,
    );

    const reset = await ask(server, {
      method: "POST",
      path: "/api/admin/users/reset",
      cookie: admin.cookie,
      body: JSON.stringify({ user: "ana" }),
    });
    assert.equal(reset.status, 200);
    assert.match(reset.json.path, /^\/p\//);
    assert.notEqual(reset.json.path, made.json.path, "link novo e outro");
    assert.equal(reset.json.user.hasPassword, false);

    assert.equal((await ask(server, { path: "/api/me", cookie: ana.cookie })).status, 401, "sessao caiu");
    assert.equal(
      (await mtxAuth(server, { action: "publish", user: "ana", password: "senha-da-ana", path: "ana" })).status,
      401,
      "senha antiga nao publica mais",
    );
    assert.equal((await ask(server, { path: made.json.path })).status, 410, "link antigo morreu");

    const newToken = reset.json.path.slice(3);
    assert.equal((await ask(server, { path: reset.json.path })).status, 200);
    const done = await ask(server, {
      method: "POST",
      path: "/api/first-access",
      body: JSON.stringify({ t: newToken, password: "senha-nova-da-ana", again: "senha-nova-da-ana" }),
    });
    assert.equal(done.status, 200);
    assert.equal((await mtxAuth(server, { action: "publish", user: "ana", password: "senha-nova-da-ana", path: "ana" })).status, 200);
  } finally {
    server.close();
  }
});

test("excluir usuario derruba a sessao e o publish, e o admin nao se exclui", async () => {
  const server = await listen();
  try {
    const admin = await login(server, "spartan", "senha-do-admin");
    const made = await ask(server, {
      method: "POST",
      path: "/api/admin/users",
      cookie: admin.cookie,
      body: JSON.stringify({ user: "beto" }),
    });
    await ask(server, {
      method: "POST",
      path: "/api/first-access",
      body: JSON.stringify({ t: made.json.path.slice(3), password: "senha-do-beto", again: "senha-do-beto" }),
    });
    const beto = await login(server, "beto", "senha-do-beto");
    assert.equal(beto.status, 200);

    const removed = await ask(server, {
      method: "POST",
      path: "/api/admin/users/delete",
      cookie: admin.cookie,
      body: JSON.stringify({ user: "beto" }),
    });
    assert.equal(removed.status, 200);
    assert.equal((await ask(server, { path: "/api/me", cookie: beto.cookie })).status, 401);
    assert.equal(
      (await mtxAuth(server, { action: "publish", user: "beto", password: "senha-do-beto", path: "beto" })).status,
      401,
    );
    assert.equal((await login(server, "beto", "senha-do-beto")).status, 401);

    const self = await ask(server, {
      method: "POST",
      path: "/api/admin/users/delete",
      cookie: admin.cookie,
      body: JSON.stringify({ user: "spartan" }),
    });
    assert.equal(self.status, 409);
    const missing = await ask(server, {
      method: "POST",
      path: "/api/admin/users/delete",
      cookie: admin.cookie,
      body: JSON.stringify({ user: "fantasma" }),
    });
    assert.equal(missing.status, 404);
  } finally {
    server.close();
  }
});

test("o motor entra com segredo: publicar exige conta valida, ler basta a conta de servico", async () => {
  const server = await listen();
  try {
    const noSecret = await ask(server, {
      method: "POST",
      path: "/api/mtx-auth",
      body: JSON.stringify({ action: "read", user: "site", password: "leitura" }),
    });
    assert.equal(noSecret.status, 401, "sem segredo nada entra");

    const wrong = await mtxAuth(server, { action: "read", user: "site", password: "leitura" }, "segredo-errado");
    assert.equal(wrong.status, 401);

    const read = await mtxAuth(server, { action: "read", user: "site", password: "leitura" });
    assert.equal(read.status, 200);
    assert.equal(read.json.ok, true);

    const readNoPassword = await mtxAuth(server, { action: "read", user: "site", password: "" });
    assert.equal(readNoPassword.status, 401);

    const publishService = await mtxAuth(server, { action: "publish", user: "site", password: "leitura", path: "site" });
    assert.equal(publishService.status, 401, "conta de servico nao publica");

    const publishNobody = await mtxAuth(server, { action: "publish", user: "ninguem", password: "sei-la", path: "ninguem" });
    assert.equal(publishNobody.status, 401);

    const admin = await login(server, "spartan", "senha-do-admin");
    const made = await ask(server, {
      method: "POST",
      path: "/api/admin/users",
      cookie: admin.cookie,
      body: JSON.stringify({ user: "caio" }),
    });
    const publishBefore = await mtxAuth(server, { action: "publish", user: "caio", password: "x", path: "caio" });
    assert.equal(publishBefore.status, 401, "sem senha definida nao publica");

    await ask(server, {
      method: "POST",
      path: "/api/first-access",
      body: JSON.stringify({ t: made.json.path.slice(3), password: "senha-do-caio", again: "senha-do-caio" }),
    });
    const publishOk = await mtxAuth(server, { action: "publish", user: "caio", password: "senha-do-caio", path: "caio" });
    assert.equal(publishOk.status, 200);
    const publishWrongPassword = await mtxAuth(server, { action: "publish", user: "caio", password: "senha-errada", path: "caio" });
    assert.equal(publishWrongPassword.status, 401);
    const publishOtherPath = await mtxAuth(server, { action: "publish", user: "caio", password: "senha-do-caio", path: "ana" });
    assert.equal(publishOtherPath.status, 401, "a conta so publica no proprio caminho");
    const publishUpperPath = await mtxAuth(server, { action: "publish", user: "caio", password: "senha-do-caio", path: "Caio" });
    assert.equal(publishUpperPath.status, 401, "caminho e sempre minusculo");
    const publishNoPath = await mtxAuth(server, { action: "publish", user: "caio", password: "senha-do-caio" });
    assert.equal(publishNoPath.status, 401, "sem caminho nao publica");
  } finally {
    server.close();
  }
});

