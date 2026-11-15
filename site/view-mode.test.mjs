import assert from "node:assert/strict";
import test from "node:test";

import {
  VIEW_MOBILE,
  VIEW_PC,
  cleanViewMode,
  nextViewMode,
  readViewMode,
  rememberViewMode,
  viewModeLabel,
} from "./public/view-mode.mjs";

test("modo de tela só aceita pc ou mobile", () => {
  assert.equal(cleanViewMode("pc"), VIEW_PC);
  assert.equal(cleanViewMode("Mobile"), VIEW_MOBILE);
  assert.equal(cleanViewMode("tablet"), "");
  assert.equal(cleanViewMode(""), "");
});

test("o navegador lembra o modo e o botão mostra o outro", () => {
  const store = new Map();
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
  };
  assert.equal(readViewMode(storage), "");
  assert.equal(rememberViewMode(storage, "mobile"), VIEW_MOBILE);
  assert.equal(readViewMode(storage), VIEW_MOBILE);
  assert.equal(viewModeLabel(VIEW_MOBILE), "Modo PC");
  assert.equal(viewModeLabel(VIEW_PC), "Modo Mobile");
  assert.equal(nextViewMode(VIEW_MOBILE), VIEW_PC);
  assert.equal(nextViewMode(VIEW_PC), VIEW_MOBILE);
});
