import assert from "node:assert/strict";
import test from "node:test";

import {
  HAPPY_GIFS,
  SAD_GIFS,
  countViewers,
  createTheaterState,
  dropViewer,
  pickNextGif,
  readPeerVolume,
  savePeerVolume,
  theaterActive,
  theaterAfterEscape,
  theaterAfterMove,
  theaterAfterTick,
  theaterAfterToggle,
  theaterHeaderVisible,
  touchViewer,
} from "./public/theater.mjs";

test("modo teatro automático entra após 30 segundos com live tocando e sai ao mexer o mouse", () => {
  let state = createTheaterState();
  state = theaterAfterTick(state, true, 1000, 30000);
  assert.equal(theaterActive(state), false);
  state = theaterAfterTick(state, true, 31000, 30000);
  assert.equal(theaterActive(state), true);
  assert.equal(theaterHeaderVisible(state), false);

  state = theaterAfterMove(state, 300, 32000, 56);
  assert.equal(theaterActive(state), false);
  assert.equal(theaterHeaderVisible(state), true);
});

test("modo teatro manual ativa na hora, mostra topo ao encostar em cima e sai com Esc", () => {
  let state = createTheaterState();
  state = theaterAfterToggle(state, 5000);
  assert.equal(state.manual, true);
  assert.equal(theaterActive(state), true);
  assert.equal(theaterHeaderVisible(state), false);

  state = theaterAfterMove(state, 200, 6000, 56);
  assert.equal(theaterActive(state), true);
  assert.equal(theaterHeaderVisible(state), false);

  state = theaterAfterMove(state, 12, 7000, 56);
  assert.equal(theaterActive(state), true);
  assert.equal(theaterHeaderVisible(state), true);

  state = theaterAfterEscape(state, 8000);
  assert.equal(theaterActive(state), false);
  assert.equal(theaterHeaderVisible(state), true);
});

test("volume salvo por amigo lembra o nível de cada apelido separadamente", () => {
  let memory = {};
  memory = savePeerVolume(memory, "Bresley", 80, false);
  memory = savePeerVolume(memory, "Joao", 35, false);
  assert.deepEqual(readPeerVolume(memory, "Bresley"), { step: 80, muted: false });
  assert.deepEqual(readPeerVolume(memory, "Joao"), { step: 35, muted: false });
  assert.deepEqual(readPeerVolume(memory, "Outro"), { step: 100, muted: true });

  memory = savePeerVolume(memory, "Joao", 0, true);
  assert.deepEqual(readPeerVolume(memory, "Joao"), { step: 35, muted: true });
});

test("contador de espectadores soma quem está assistindo, remove na hora ao pausar/sair e expira quem saiu", () => {
  const book = new Map();
  touchViewer(book, "Bresley", "v1", 1000);
  touchViewer(book, "Bresley", "v2", 2000);
  assert.equal(countViewers(book, "Bresley", 3000, 4500), 2);
  dropViewer(book, "Bresley", "v1");
  assert.equal(countViewers(book, "Bresley", 3000, 4500), 1);
  assert.equal(countViewers(book, "Bresley", 7000, 4500), 0);
});

test("roleta de gifs de triste e feliz percorre todos os itens sem repetir até fechar o ciclo", () => {
  assert.equal(SAD_GIFS.length, 12);
  assert.equal(HAPPY_GIFS.length, 12);

  let idx = -1;
  const seenSad = [];
  for (let i = 0; i < SAD_GIFS.length; i += 1) {
    const res = pickNextGif(SAD_GIFS, idx);
    idx = res.index;
    seenSad.push(res.src);
  }
  assert.equal(new Set(seenSad).size, SAD_GIFS.length);
  assert.equal(pickNextGif(SAD_GIFS, idx).src, SAD_GIFS[0]);

  let hIdx = -1;
  const seenHappy = [];
  for (let i = 0; i < HAPPY_GIFS.length; i += 1) {
    const res = pickNextGif(HAPPY_GIFS, hIdx);
    hIdx = res.index;
    seenHappy.push(res.src);
  }
  assert.equal(new Set(seenHappy).size, HAPPY_GIFS.length);
  assert.equal(pickNextGif(HAPPY_GIFS, hIdx).src, HAPPY_GIFS[0]);
});
