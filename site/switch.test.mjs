import assert from "node:assert/strict";
import test from "node:test";
import { screenPhase } from "./public/screen-switch.mjs";
import { collectSwitching, collectSwitchKinds } from "./server.mjs";

const entry = { name: "ana", offline: false, offlineAt: 0, switching: false };

test("troca de tela segura o nome e não conta como queda", () => {
  const phase = screenPhase(entry, false, true, 1_000, 90_000);
  assert.equal(phase.action, "switch");
  assert.equal(phase.entry.switching, true);
  assert.equal(phase.entry.offline, false);
});

test("enquanto o aviso vale, a live antiga não reabre o player", () => {
  const phase = screenPhase(entry, true, true, 1_500, 90_000);
  assert.equal(phase.action, "switch");
});

test("quando a tela nova entra, o player reabre no ao vivo", () => {
  const phase = screenPhase({ ...entry, switching: true }, true, false, 2_000, 90_000);
  assert.equal(phase.action, "revive");
  assert.equal(phase.entry.switching, false);
});

test("se a troca falha, a espera de 90s começa depois", () => {
  const phase = screenPhase({ ...entry, switching: true }, false, false, 5_000, 90_000);
  assert.equal(phase.action, "offline");
  assert.equal(phase.entry.offlineAt, 5_000);
});

test("uma live que reiniciou sem o aviso reabre o player", () => {
  const phase = screenPhase({ ...entry, readyAt: 5_000 }, true, false, 9_000, 90_000, 1_000);
  assert.equal(phase.action, "revive");
});

test("o mesmo instante da live não reabre o player", () => {
  const phase = screenPhase({ ...entry, readyAt: 5_000 }, true, false, 9_000, 90_000, 5_000);
  assert.equal(phase.action, "stay");
});

test("o aviso some quando a live nova fica pronta", () => {
  const marks = new Map([["ana", { at: 1_000, until: 30_000, kind: "quality" }]]);
  const hidden = collectSwitching(marks, [], 2_000);
  assert.deepEqual(hidden, ["ana"]);
  assert.deepEqual(collectSwitchKinds(marks), { ana: "quality" });
  const gone = collectSwitching(marks, [{ name: "ana", readyTime: new Date(3_000).toISOString() }], 4_000);
  assert.deepEqual(gone, []);
  assert.deepEqual(collectSwitchKinds(marks), {});
});
