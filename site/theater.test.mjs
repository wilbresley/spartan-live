import assert from "node:assert/strict";
import test from "node:test";

import {
  HAPPY_GIFS,
  MAX_SAVED_VOLUME_STEP,
  MAX_VOLUME_STEP,
  SAD_GIFS,
  TOAST_DURATION_MS,
  capPlayStartVolume,
  clampVolumeStep,
  audienceMarks,
  countViewers,
  createTheaterState,
  createToastQueue,
  dismissActiveToast,
  holdToast,
  dropViewer,
  enqueueArrivalToasts,
  pickNextGif,
  pairStacks,
  readPeerVolume,
  savePeerVolume,
  shouldUseArrivalToast,
  theaterActive,
  theaterAfterEscape,
  theaterAfterMove,
  theaterAfterTick,
  theaterAfterToggle,
  theaterHeaderVisible,
  tickToastQueue,
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

test("volume permite boost até 200% mas salva no máximo 100% e inicia live em até 100%", () => {
  assert.equal(MAX_VOLUME_STEP, 200);
  assert.equal(MAX_SAVED_VOLUME_STEP, 100);
  assert.equal(clampVolumeStep(175), 175);
  assert.equal(clampVolumeStep(250), 200);
  assert.equal(capPlayStartVolume(180), 100);
  assert.equal(capPlayStartVolume(65), 65);

  let memory = {};
  memory = savePeerVolume(memory, "Bresley", 185, false);
  assert.deepEqual(readPeerVolume(memory, "Bresley"), { step: 100, muted: false });

  const tampered = { Bresley: { step: 200, muted: false } };
  assert.deepEqual(readPeerVolume(tampered, "Bresley"), { step: 100, muted: false });
});

test("balão de chegada entra em fila de 5s sem encavalar e pausa com o mouse em cima", () => {
  assert.equal(TOAST_DURATION_MS, 5000);
  assert.equal(shouldUseArrivalToast({ theaterOn: true, fullscreenActive: false, railVisible: false }), true);
  assert.equal(shouldUseArrivalToast({ theaterOn: false, fullscreenActive: true, railVisible: false }), true);
  assert.equal(shouldUseArrivalToast({ theaterOn: false, fullscreenActive: false, railVisible: false }), true);
  assert.equal(shouldUseArrivalToast({ theaterOn: false, fullscreenActive: false, railVisible: true }), false);

  let queue = createToastQueue();
  queue = enqueueArrivalToasts(queue, ["Bresley", "Joao", "Pedro"], 1000, 5000);
  assert.deepEqual(queue.active, { name: "Bresley", until: 6000 });
  assert.deepEqual(queue.queue, ["Joao", "Pedro"]);

  queue = tickToastQueue(queue, 2500, 5000);
  assert.equal(queue.active.name, "Bresley");

  queue = holdToast(queue, true, 2000);
  assert.equal(queue.active.paused, true);
  assert.equal(queue.active.remaining, 4000);
  queue = tickToastQueue(queue, 20000, 5000);
  assert.equal(queue.active.name, "Bresley");
  queue = holdToast(queue, false, 9000);
  assert.equal(queue.active.until, 13000);

  queue = tickToastQueue(queue, 13000, 5000);
  assert.deepEqual(queue.active, { name: "Joao", until: 18000 });
  assert.deepEqual(queue.queue, ["Pedro"]);

  queue = dismissActiveToast(queue, 14000, 5000);
  assert.deepEqual(queue.active, { name: "Pedro", until: 19000 });
  assert.deepEqual(queue.queue, []);

  queue = tickToastQueue(queue, 19000, 5000);
  assert.equal(queue.active, null);
  assert.deepEqual(queue.queue, []);
});

test("olho conta a conta logada, ampulheta o temporário e infinito o permanente", () => {
  assert.equal(audienceMarks(2, 0), "👁 2");
  assert.equal(audienceMarks(0, 3), "⏳ 3");
  assert.equal(audienceMarks(1, 4), "👁 1  ⏳ 4");
  assert.equal(audienceMarks(1, 2, 3), "👁 1  ⏳ 2  ∞ 3");
  assert.equal(audienceMarks(0, 0, 2), "∞ 2");
  assert.equal(audienceMarks(0, 0), "");
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
  assert.ok(SAD_GIFS.every((src) => /^\/gifs\/sad-\d+\.gif\?v3$/.test(src)));
  assert.ok(HAPPY_GIFS.every((src) => /^\/gifs\/happy-\d+\.gif\?v3$/.test(src)));
  assert.ok(!SAD_GIFS.some((src) => src.includes("empty-sad")));

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

test("duas lives ficam uma sobre a outra só abaixo da metade do monitor", () => {
  assert.equal(pairStacks(2, 900, 1920), true);
  assert.equal(pairStacks(2, 960, 1920), false);
  assert.equal(pairStacks(2, 1600, 1920), false);
  assert.equal(pairStacks(1, 400, 1920), false);
  assert.equal(pairStacks(3, 400, 1920), false);
  assert.equal(pairStacks(2, 400, 0), false);
});
