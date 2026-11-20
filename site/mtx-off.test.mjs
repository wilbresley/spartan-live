import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Processo separado de propósito: o servidor lê MTX_AUTH_SECRET quando carrega,
// então só um módulo novo mostra o comportamento de "motor sem segredo".
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "spartan-mtx-off-"));
process.env.VIEWER_USER = "spartan";
process.env.SESSION_SECRET = "teste-sessao";
process.env.MTX_USER = "site";
process.env.MTX_PASSWORD = "leitura";
delete process.env.MTX_AUTH_SECRET;
process.env.DATA_DIR = dataDir;

const { ROLE_ADMIN, createUser, emptyStore, saveUsers, setUserPassword } = await import("./users.mjs");
const store = emptyStore();
createUser(store, "spartan", { role: ROLE_ADMIN, now: 1 });
setUserPassword(store, "spartan", "senha-do-admin", 2);
saveUsers(path.join(dataDir, "users.json"), store);

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

test("sem MTX_AUTH_SECRET o endpoint do motor responde 503 mesmo com o segredo vazio", async () => {
  const server = await listen();
  try {
    const off = await ask(server, {
      method: "POST",
      path: "/api/mtx-auth?secret=",
      body: JSON.stringify({ action: "read", user: "site", password: "leitura" }),
    });
    assert.equal(off.status, 503);
  } finally {
    server.close();
  }
});

test("sem MTX_AUTH_SECRET o login do site continua funcionando", async () => {
  const server = await listen();
  try {
    const res = await ask(server, {
      method: "POST",
      path: "/api/login",
      body: JSON.stringify({ user: "spartan", password: "senha-do-admin" }),
    });
    assert.equal(res.status, 200);
    assert.match(String(res.headers["set-cookie"]), /^spartan_live=/);
  } finally {
    server.close();
  }
});
