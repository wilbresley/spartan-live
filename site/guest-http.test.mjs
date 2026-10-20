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

const { onRequest, signSession, guestMaySee, rememberShare, accessIdOf } = await import("./server.mjs");

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
    assert.equal(made.json.temporary.hours, 12);
    assert.match(made.json.temporary.path, /^\/v\/[\w-]{16,64}$/);

    const again = await ask(server, {
      method: "POST",
      path: "/api/guest",
      cookie: owner,
      body: JSON.stringify({ hours: 3 }),
    });
    assert.equal(again.status, 409);

    const permanent = await ask(server, {
      method: "POST",
      path: "/api/guest",
      cookie: owner,
      body: JSON.stringify({ permanent: true }),
    });
    assert.equal(permanent.status, 200);
    assert.ok(permanent.json.permanent.active);
    assert.match(permanent.json.permanent.path, /^\/v\/[\w-]{16,64}$/);
    assert.notEqual(permanent.json.permanent.path, made.json.temporary.path);

    const enter = await ask(server, { path: made.json.temporary.path });
    assert.equal(enter.status, 302);
    assert.equal(enter.headers.location, "/");
    const guest = cookieOf(enter.headers);

    const me = await ask(server, { path: "/api/me", cookie: guest });
    assert.equal(me.json.role, "guest");
    assert.equal(me.json.kind, "temporary");
    assert.equal(me.json.accessId, 2);
    assert.equal(me.json.mustChange, false);
    assert.ok(me.json.exp > Date.now());

    await ask(server, {
      method: "POST",
      path: "/api/share",
      body: JSON.stringify({ name: "ana", user: "pub", password: "pub-segredo", guestsTemp: true, guestsPerm: false }),
    });

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
    assert.equal(counted.json.permanent, 0);

    const permEnter = await ask(server, { path: permanent.json.permanent.path });
    const permGuest = cookieOf(permEnter.headers);
    const permMe = await ask(server, { path: "/api/me", cookie: permGuest });
    assert.equal(permMe.json.kind, "permanent");
    assert.equal(permMe.json.accessId, 3);

    await ask(server, { method: "POST", path: "/api/unwatch", cookie: owner, body: JSON.stringify({ name: "ana" }) });
    const afterLeave = await ask(server, {
      method: "POST",
      path: "/api/viewers",
      body: JSON.stringify({ name: "ana", user: "pub", password: "pub-segredo" }),
    });
    assert.equal(afterLeave.json.viewers, 0);
    assert.equal(afterLeave.json.guests, 1);

    const download = await ask(server, { path: "/download/SpartanLive.exe", cookie: guest });
    assert.equal(download.status, 401);

    const revokedTemp = await ask(server, {
      method: "POST",
      path: "/api/guest/revoke",
      cookie: owner,
      body: JSON.stringify({ kind: "temporary" }),
    });
    assert.equal(revokedTemp.json.temporary, null);
    assert.ok(revokedTemp.json.permanent.active);
    const ended = await ask(server, { path: "/api/me", cookie: guest });
    assert.equal(ended.status, 401);
    assert.equal(ended.json.guestEnded, true);
    assert.equal(ended.json.guestEnd, "revoked");
    assert.equal(ended.headers["set-cookie"], undefined);
    const againEnded = await ask(server, { path: "/api/streams", cookie: guest });
    assert.equal(againEnded.json.guestEnd, "revoked");
    const page = await ask(server, { path: made.json.temporary.path, cookie: guest });
    assert.match(page.raw, /Esse convite foi revogado/);

    const expired = `spartan_live=${encodeURIComponent(signSession("spartan", Date.now(), {
      role: "guest",
      gid: made.json.temporary.path.slice(3),
      kind: "temporary",
      exp: Date.now() - 1000,
    }))}`;
    const timedOut = await ask(server, { path: "/api/me", cookie: expired });
    assert.equal(timedOut.json.guestEnd, "expired");
    const timedPage = await ask(server, { path: made.json.temporary.path, cookie: expired });
    assert.match(timedPage.raw, /O tempo desse convite acabou/);

    const stillPerm = await ask(server, { path: "/api/me", cookie: permGuest });
    assert.equal(stillPerm.status, 200);
    assert.equal(stillPerm.json.kind, "permanent");

    const fresh = await ask(server, {
      method: "POST",
      path: "/api/guest",
      cookie: owner,
      body: JSON.stringify({ hours: 24 }),
    });
    assert.equal(fresh.status, 200);
    assert.notEqual(fresh.json.temporary.path, made.json.temporary.path);

    const permId = permanent.json.permanent.path.slice(3);
    const tempId = fresh.json.temporary.path.slice(3);
    // Cookie com kind errado ainda resolve pelo gid do permanente.
    const wrongKindCookie = `spartan_live=${encodeURIComponent(signSession("spartan", Date.now(), {
      role: "guest",
      gid: permId,
      kind: "temporary",
      exp: Date.now() + 86400000,
    }))}`;
    const fixedKind = await ask(server, { path: "/api/me", cookie: wrongKindCookie });
    assert.equal(fixedKind.json.kind, "permanent");
    assert.equal(fixedKind.json.accessId, 3);

    rememberShare("ana", true, false);
    const permSession = { role: "guest", kind: "temporary", gid: permId };
    const tempSession = { role: "guest", kind: "permanent", gid: tempId };
    assert.equal(accessIdOf(permSession), 3);
    assert.equal(accessIdOf(tempSession), 2);
    assert.equal(guestMaySee(permSession, "ana"), false);
    assert.equal(guestMaySee(tempSession, "ana"), true);
    const shareOnlyPerm = await ask(server, {
      method: "POST",
      path: "/api/share",
      body: JSON.stringify({ name: "ana", user: "pub", password: "pub-segredo", guestsTemp: false, guestsPerm: true }),
    });
    assert.equal(shareOnlyPerm.status, 200);
    assert.equal(shareOnlyPerm.json.guestsTemp, false);
    assert.equal(shareOnlyPerm.json.guestsPerm, true);
    assert.equal(guestMaySee(permSession, "ana"), true);
    assert.equal(guestMaySee(tempSession, "ana"), false);
    await ask(server, {
      method: "POST",
      path: "/api/share",
      body: JSON.stringify({ name: "ana", user: "pub", password: "pub-segredo", guestsTemp: true, guestsPerm: false }),
    });
    assert.equal(guestMaySee(permSession, "ana"), false);
    assert.equal(guestMaySee(tempSession, "ana"), true);
    await ask(server, {
      method: "POST",
      path: "/api/share",
      body: JSON.stringify({ name: "ana", user: "pub", password: "pub-segredo", guestsTemp: false, guestsPerm: false }),
    });
    assert.equal(guestMaySee(permSession, "ana"), false);
    assert.equal(guestMaySee(tempSession, "ana"), false);
    // Aliases do programa / payloads antigos (guests + permanent).
    const shareAlias = await ask(server, {
      method: "POST",
      path: "/api/share",
      body: JSON.stringify({ name: "ana", user: "pub", password: "pub-segredo", guests: false, permanent: true }),
    });
    assert.equal(shareAlias.json.guestsTemp, false);
    assert.equal(shareAlias.json.guestsPerm, true);
    assert.equal(guestMaySee(permSession, "ana"), true);
    assert.equal(guestMaySee(tempSession, "ana"), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
