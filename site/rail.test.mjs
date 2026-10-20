import assert from "node:assert/strict";
import test from "node:test";
import {
  createRailState,
  railAfterEmpty,
  railAfterHover,
  railAfterPinToggle,
  visualRailOpen,
} from "./public/rail-peek.mjs";

const closed = createRailState(false);

test("aproximação do mouse abre a lista e ao sair fecha se não estiver fixada", () => {
  const open = railAfterHover(closed, true);
  assert.equal(visualRailOpen(open), true);
  const closedAgain = railAfterHover(open, false);
  assert.equal(visualRailOpen(closedAgain), false);
});

test("fixar mantém a lista aberta sem o mouse e desafixar volta ao automático", () => {
  const hovered = railAfterHover(closed, true);
  const pinned = railAfterPinToggle(hovered);
  assert.equal(pinned.pinned, true);
  assert.equal(visualRailOpen(railAfterHover(pinned, false)), true);
  const unpinned = railAfterPinToggle(pinned);
  assert.equal(unpinned.pinned, false);
  assert.equal(visualRailOpen(railAfterHover(unpinned, false)), false);
});

test("grid vazio com gente online força a lista aberta mesmo sem mouse", () => {
  assert.equal(visualRailOpen(closed, { forceOpen: true }), true);
  assert.equal(visualRailOpen(closed, { forceOpen: false }), false);
});

test("sem ninguém a lista volta ao compacto e perde o fixar", () => {
  const open = railAfterPinToggle(railAfterHover(closed, true));
  const hidden = railAfterEmpty(open);
  assert.equal(visualRailOpen(hidden), false);
  assert.equal(hidden.pinned, false);
  assert.equal(railAfterEmpty(closed), closed);
});
