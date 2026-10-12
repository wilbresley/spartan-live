import assert from "node:assert/strict";
import test from "node:test";

process.env.VIEWER_USER = "spartan";
process.env.VIEWER_PASSWORD = "segredo";
process.env.SESSION_SECRET = "teste-sessao";
process.env.MTX_USER = "site";
process.env.MTX_PASSWORD = "leitura";

const { passwordsMatch, requestPath, safeHlsRest, safeHlsSearch, signSession, readSession, safeStreamName, thumbFile } = await import("./server.mjs");

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
