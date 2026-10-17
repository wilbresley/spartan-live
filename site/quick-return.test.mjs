import assert from "node:assert/strict";
import test from "node:test";
import { claimReturn, pruneReturns, rememberReturn } from "./public/quick-return.mjs";

test("volta em menos de 1 minuto devolve o play e o volume", () => {
  const memory = rememberReturn({}, "ana", { playing: true, volume: 0.4, muted: false }, 1_000);
  const claim = claimReturn(memory, "ana", 50_000);
  assert.equal(claim.back.playing, true);
  assert.equal(claim.back.volume, 0.4);
  assert.equal(claim.back.muted, false);
  assert.equal(claim.memory.ana, undefined);
});

test("passou de 1 minuto não devolve", () => {
  const memory = rememberReturn({}, "ana", { playing: true, volume: 0.4, muted: false }, 1_000);
  const claim = claimReturn(memory, "ana", 61_000);
  assert.equal(claim.back, null);
  assert.equal(claim.memory.ana, undefined);
});

test("quem não estava no grid não volta sozinho", () => {
  const claim = claimReturn({}, "ana", 2_000);
  assert.equal(claim.back, null);
});

test("som mudo continua mudo", () => {
  const memory = rememberReturn({}, "ana", { playing: true, volume: 1, muted: true }, 1_000);
  const claim = claimReturn(memory, "ana", 2_000);
  assert.equal(claim.back.muted, true);
  assert.equal(claim.back.playing, true);
});

test("o prazo esquecido sai da memória", () => {
  const memory = rememberReturn({}, "ana", { playing: false, volume: 0.2, muted: false }, 1_000);
  assert.deepEqual(pruneReturns(memory, 70_000), {});
  assert.equal(pruneReturns(memory, 30_000).ana.playing, false);
});
