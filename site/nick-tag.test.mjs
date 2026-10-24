import assert from "node:assert/strict";
import test from "node:test";
import { cleanNick, kindMark, sortPeople } from "./public/nick-tag.mjs";

test("apelido do crachá tem 2 a 24 caracteres e não aceita vazio", () => {
  assert.equal(cleanNick("  João  "), "João");
  assert.equal(cleanNick("A"), "");
  assert.equal(cleanNick("   "), "");
  assert.equal(cleanNick("x".repeat(25)), "");
  assert.equal(cleanNick("Maria_2"), "Maria_2");
  assert.equal(cleanNick("ok<script>"), "");
});

test("selo do caminho bate com olho, ampulheta e infinito", () => {
  assert.equal(kindMark("owner"), "👁");
  assert.equal(kindMark("temporary"), "⏳");
  assert.equal(kindMark("permanent"), "∞");
  assert.equal(kindMark(""), "");
});

test("lista de espectadores ordena pelo apelido", () => {
  const rows = sortPeople([
    { nick: "Renato", kind: "temporary" },
    { nick: "Adi", kind: "owner" },
    { nick: "  ", kind: "owner" },
  ]);
  assert.deepEqual(rows.map((row) => row.nick), ["Adi", "Renato"]);
});
