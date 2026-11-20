import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "spartan-login-"));
process.env.VIEWER_USER = "spartan";
process.env.SESSION_SECRET = "teste-sessao";
process.env.MTX_USER = "site";
process.env.MTX_PASSWORD = "leitura";
process.env.DATA_DIR = dataDir;

// A conta admin existe antes do primeiro pedido: o servidor lê o users.json na
// primeira vez que precisa dele e guarda em memória.
const { ROLE_ADMIN, createUser, emptyStore, saveUsers, setUserPassword } = await import("./users.mjs");
const USERS_FILE = path.join(dataDir, "users.json");
function seed(password) {
  const store = emptyStore();
  createUser(store, "spartan", { role: ROLE_ADMIN, now: 1 });
  setUserPassword(store, "spartan", password, 2);
  saveUsers(USERS_FILE, store);
}
seed("senha-antiga-123");

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

test("trocar a senha derruba o cookie dos outros aparelhos e mantém o de quem trocou", async () => {
  const server = await listen();
  try {
    const wrong = await ask(server, {
      method: "POST",
      path: "/api/login",
      body: JSON.stringify({ user: "spartan", password: "senha-errada" }),
    });
    assert.equal(wrong.status, 401);

    const login = await ask(server, {
      method: "POST",
      path: "/api/login",
      body: JSON.stringify({ user: "spartan", password: "senha-antiga-123" }),
    });
    assert.equal(login.status, 200);
    const oldCookie = cookieOf(login.headers);
    assert.match(oldCookie, /^spartan_live=/);
    assert.match(String(login.headers["set-cookie"]), /HttpOnly/);

    const me = await ask(server, { path: "/api/me", cookie: oldCookie });
    assert.equal(me.status, 200);
    assert.equal(me.json.role, "admin");

    const changed = await ask(server, {
      method: "POST",
      path: "/api/password",
      cookie: oldCookie,
      body: JSON.stringify({ current: "senha-antiga-123", next: "senha-nova-987", again: "senha-nova-987" }),
    });
    assert.equal(changed.status, 200);
    const newCookie = cookieOf(changed.headers);
    assert.notEqual(newCookie, oldCookie, "quem trocou recebe um cookie novo na hora");

    assert.equal((await ask(server, { path: "/api/me", cookie: newCookie })).status, 200);
    assert.equal(
      (await ask(server, { path: "/api/me", cookie: oldCookie })).status,
      401,
      "cookie emitido antes da troca não abre mais o site",
    );

    const relogin = await ask(server, {
      method: "POST",
      path: "/api/login",
      body: JSON.stringify({ user: "spartan", password: "senha-nova-987" }),
    });
    assert.equal(relogin.status, 200);
  } finally {
    server.close();
  }
});