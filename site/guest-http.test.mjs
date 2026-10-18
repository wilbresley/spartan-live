import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "spartan-guest-"));
process.env.VIEWER_USER = "spartan";
process.env.VIEWER_PASSWORD = "segredo-longo";
process.env.SESSION_SECRET = "teste-sessao";
process.env.MTX_USER = "site";
process.env.MTX_PASSWORD = "leitura";
process.env.PUBLISH_USER = "pub";
process.env.PUBLISH_PASSWORD = "pub-segredo";
process.env.DATA_DIR = dataDir;

const { onRequest, signSession } = await import("./server.mjs");

function listen() {
  const server = http.createServer(onRequest);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function ask(server, { method = "GET", path: target = "/", cookie = "", body = "", headers = {} } = {}) {
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
        ...headers,
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
  return line.split(";")[0];
}

test("um convite por vez, o convidado assiste e o link morto fica cinza", async () => {
  const server = await listen();
  try {
    const owner = `spartan_live=${encodeURIComponent(signSession("spartan"))}`;
    const dead = await ask(server, { path: "/v/nao-existe-aqui" });
    assert.equal(dead.status, 200);
    assert.match(dead.raw, /Esse link não existe mais/);
    assert.match(dead.raw, /sad-1\.gif/);

    const blocked = await ask(server, { method: "POST", path: "/api/guest", body: JSON.stringify({ hours: 12 }) });
    assert.equal(blocked.status, 401);

    const made = await ask(server, {
      method: "POST",
      path: "/api/guest",
      cookie: owner,
      body: JSON.stringify({ hours: 12 }),
    });
    assert.equal(made.status, 200);
    assert.equal(made.json.hours, 12);
    assert.match(made.json.path, /^\/v\/[\w-]{16,64}$/);

    const again = await ask(server, {
      method: "POST",
      path: "/api/guest",
      cookie: owner,
      body: JSON.stringify({ hours: 3 }),
    });
    assert.equal(again.status, 409);

    const enter = await ask(server, { path: made.json.path });
    assert.equal(enter.status, 302);
    assert.equal(enter.headers.location, "/");
    const guest = cookieOf(enter.headers);

    const me = await ask(server, { path: "/api/me", cookie: guest });
    assert.equal(me.json.role, "guest");
    assert.equal(me.json.mustChange, false);
    assert.ok(me.json.exp > Date.now());

    await ask(server, { method: "POST", path: "/api/watch", cookie: owner, body: JSON.stringify({ names: ["ana"] }) });
    await ask(server, {
      method: "POST",
      path: "/api/watch",
      cookie: guest,
      headers: { "user-agent": "visitante" },
      body: JSON.stringify({ names: ["ana"] }),
    });
    const counted = await ask(server, {
      method: "POST",
      path: "/api/viewers",
      body: JSON.stringify({ name: "ana", user: "pub", password: "pub-segredo" }),
    });
    assert.equal(counted.json.viewers, 1);
    assert.equal(counted.json.guests, 1);
    await ask(server, { method: "POST", path: "/api/unwatch", cookie: owner, body: JSON.stringify({ name: "ana" }) });
    const afterLeave = await ask(server, {
      method: "POST",
      path: "/api/viewers",
      body: JSON.stringify({ name: "ana", user: "pub", password: "pub-segredo" }),
    });
    assert.equal(afterLeave.json.viewers, 0);
    assert.equal(afterLeave.json.guests, 1);
    await ask(server, {
      method: "POST",
      path: "/api/unwatch",
      cookie: guest,
      headers: { "user-agent": "visitante" },
      body: JSON.stringify({ name: "ana" }),
    });
    await ask(server, {
      method: "POST",
      path: "/api/watch",
      cookie: owner,
      headers: { "user-agent": "mesmo" },
      body: JSON.stringify({ names: ["ana"] }),
    });
    await ask(server, {
      method: "POST",
      path: "/api/watch",
      cookie: guest,
      headers: { "user-agent": "mesmo" },
      body: JSON.stringify({ names: ["ana"] }),
    });
    const together = await ask(server, {
      method: "POST",
      path: "/api/viewers",
      body: JSON.stringify({ name: "ana", user: "pub", password: "pub-segredo" }),
    });
    assert.equal(together.json.viewers, 1);
    assert.equal(together.json.guests, 1);

    const download = await ask(server, { path: "/download/SpartanLive.exe", cookie: guest });
    assert.equal(download.status, 401);
    const password = await ask(server, {
      method: "POST",
      path: "/api/password",
      cookie: guest,
      body: JSON.stringify({ current: "x", next: "yyyyyyyy", again: "yyyyyyyy" }),
    });
    assert.equal(password.status, 401);

    const revoked = await ask(server, { method: "POST", path: "/api/guest/revoke", cookie: owner, body: "{}" });
    assert.equal(revoked.json.active, false);
    const ended = await ask(server, { path: "/api/me", cookie: guest });
    assert.equal(ended.status, 401);
    assert.equal(ended.json.guestEnded, true);
    assert.equal(ended.json.guestEnd, "revoked");
    assert.equal(ended.headers["set-cookie"], undefined);
    const againEnded = await ask(server, { path: "/api/streams", cookie: guest });
    assert.equal(againEnded.json.guestEnd, "revoked");
    const page = await ask(server, { path: made.json.path, cookie: guest });
    assert.match(page.raw, /Esse convite foi revogado/);

    const expired = `spartan_live=${encodeURIComponent(signSession("spartan", Date.now(), {
      role: "guest",
      gid: made.json.path.slice(3),
      exp: Date.now() - 1000,
    }))}`;
    const timedOut = await ask(server, { path: "/api/me", cookie: expired });
    assert.equal(timedOut.json.guestEnd, "expired");
    const timedPage = await ask(server, { path: made.json.path, cookie: expired });
    assert.match(timedPage.raw, /O tempo desse convite acabou/);

    const fresh = await ask(server, {
      method: "POST",
      path: "/api/guest",
      cookie: owner,
      body: JSON.stringify({ hours: 24 }),
    });
    assert.equal(fresh.status, 200);
    assert.notEqual(fresh.json.path, made.json.path);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
