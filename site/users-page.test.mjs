import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "spartan-users-page-"));
process.env.VIEWER_USER = "spartan";
process.env.SESSION_SECRET = "teste-sessao";
process.env.DATA_DIR = dataDir;

const { ROLE_ADMIN, createUser, emptyStore, saveUsers, setUserPassword } = await import("./users.mjs");
const store = emptyStore();
createUser(store, "spartan", { role: ROLE_ADMIN, now: 1 });
setUserPassword(store, "spartan", "senha-admin-123", 2);
saveUsers(path.join(dataDir, "users.json"), store);

const { onRequest } = await import("./server.mjs");

function listen() {
  const server = http.createServer(onRequest);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function get(server, target) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, method: "GET", path: target }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        type: String(res.headers["content-type"] || ""),
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("a página do site entrega o diálogo de contas e o módulo users-ui.mjs", async () => {
  const server = await listen();
  try {
    const page = await get(server, "/");
    assert.equal(page.status, 200);
    for (const id of ["users-pop", "users-list", "users-create", "users-name", "users-link-url", "m-set-people", "m-set-users"]) {
      assert.match(page.body, new RegExp(`id="${id}"`), `#${id} precisa existir na index.html`);
    }

    const module = await get(server, "/users-ui.mjs");
    assert.equal(module.status, 200, "sem o módulo o app.js não carrega no navegador");
    assert.match(module.type, /javascript/);
    assert.match(module.body, /export function deleteBlocked/);

    const app = await get(server, "/app.js");
    assert.equal(app.status, 200);
    assert.match(app.body, /from "\.\/users-ui\.mjs"/);
  } finally {
    server.close();
  }
});
