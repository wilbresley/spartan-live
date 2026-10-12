import assert from "node:assert/strict";
import test from "node:test";
import {
  peekSecondsLeft,
  railAfterEnter,
  railAfterInteract,
  railAfterTick,
  railAfterEmpty,
  railAfterToggle,
  visualRailOpen,
} from "./public/rail-peek.mjs";

const closed = { storedOpen: false, held: false, peekUntil: 0 };

test("quem entra abre a lista por 10 segundos", () => {
  const peeked = railAfterEnter(closed, 1000);
  assert.equal(visualRailOpen(peeked, 1000), true);
  assert.equal(peekSecondsLeft(peeked, 1000), 10);
  assert.equal(visualRailOpen(peeked, 10999), true);
  assert.equal(peekSecondsLeft(peeked, 2001), 9);
  const done = railAfterTick(peeked, 11000);
  assert.equal(visualRailOpen(done, 11000), false);
  assert.equal(peekSecondsLeft(done, 11000), 0);
});

test("outra entrada durante a contagem recomeça os 10 segundos", () => {
  const first = railAfterEnter(closed, 1000);
  const again = railAfterEnter(first, 4000);
  assert.equal(again.peekUntil, 14000);
  assert.equal(peekSecondsLeft(again, 4000), 10);
});

test("lista já aberta não ganha contagem", () => {
  const open = { storedOpen: true, held: false, peekUntil: 0 };
  const same = railAfterEnter(open, 1000);
  assert.equal(same.peekUntil, 0);
  assert.equal(visualRailOpen(same, 20000), true);
});

test("qualquer interação cancela a contagem e deixa a lista aberta", () => {
  const peeked = railAfterEnter(closed, 1000);
  const held = railAfterInteract(peeked, 3000);
  assert.equal(held.peekUntil, 0);
  assert.equal(held.held, true);
  assert.equal(visualRailOpen(held, 30000), true);
  assert.equal(railAfterInteract(closed, 3000), closed);
});

test("ocultar durante a contagem volta ao compacto sem guardar aberto", () => {
  const peeked = railAfterEnter(closed, 1000);
  const hidden = railAfterToggle(peeked, 2000);
  assert.equal(hidden.storedOpen, false);
  assert.equal(hidden.held, false);
  assert.equal(visualRailOpen(hidden, 2000), false);
});

test("sem ninguém a lista volta ao compacto", () => {
  const open = { storedOpen: true, held: true, peekUntil: 5000 };
  const hidden = railAfterEmpty(open);
  assert.equal(visualRailOpen(hidden, 1000), false);
  assert.equal(hidden.storedOpen, false);
  assert.equal(railAfterEmpty(closed), closed);
});

test("depois da interação o botão ocultar fecha de verdade", () => {
  const held = railAfterInteract(railAfterEnter(closed, 1000), 2000);
  const hidden = railAfterToggle(held, 3000);
  assert.equal(visualRailOpen(hidden, 3000), false);
  const shown = railAfterToggle(hidden, 4000);
  assert.equal(shown.storedOpen, true);
  assert.equal(visualRailOpen(shown, 4000), true);
});
