import assert from "node:assert/strict";
import test from "node:test";
import { formatOnAir, isFollowingLive, liveLedSynced, playbackGlitch, resumeTime, rewindWindow, scrubRatio, scrubTarget, shouldSnapToLive } from "./public/buffer-math.mjs";
import { dueChimes, freshArrivals, nextPresence } from "./public/presence.mjs";

test("o ao vivo fica verde só com atraso de até 7 segundos", () => {
  assert.equal(liveLedSynced(93, 100), true);
  assert.equal(liveLedSynced(92, 100), false);
  assert.equal(liveLedSynced(100, 100), true);
});

test("a bolinha fica vermelha só perto do ao vivo", () => {
  assert.equal(isFollowingLive(90, 100), true);
  assert.equal(isFollowingLive(80, 100), false);
  assert.equal(isFollowingLive(100, 100), true);
});

test("pausa longa recomeça no começo da janela", () => {
  const bounds = { start: 100, end: 400 };
  assert.equal(resumeTime(250, 301, bounds), 100);
  assert.equal(resumeTime(250, 20, bounds), 250);
  assert.equal(resumeTime(50, 10, bounds), 100);
});

test("a barra usa só os 2 minutos que dá para voltar", () => {
  assert.deepEqual(rewindWindow(0, 500, 120), { start: 380, end: 500 });
  assert.deepEqual(rewindWindow(100, 150, 120), { start: 100, end: 150 });
  assert.equal(rewindWindow(10, 10, 120), null);
  assert.equal(scrubRatio(150, 100, 200), 0.5);
  assert.equal(scrubRatio(50, 100, 200), 0);
  assert.equal(scrubRatio(900, 100, 200), 1);
  assert.equal(scrubTarget(0, 380, 500), 380);
  assert.equal(scrubTarget(1, 380, 500), 500);
});

test("mais de um minuto e meio atrás volta para o ao vivo", () => {
  assert.equal(shouldSnapToLive(90), false);
  assert.equal(shouldSnapToLive(90.1), true);
  assert.equal(shouldSnapToLive(30), false);
});

test("o relógio mostra o tempo no ar", () => {
  assert.equal(formatOnAir(0), "0:00");
  assert.equal(formatOnAir(65000), "1:05");
  assert.equal(formatOnAir(3661000), "1:01:01");
});

test("som só toca em entrada e saída de verdade", () => {
  const first = nextPresence({ primed: false, people: {} }, ["ana"], [], 1_000);
  assert.deepEqual(first.enter, []);
  assert.deepEqual(first.exit, []);

  const joined = nextPresence(first, ["ana", "bia"], [], 2_000);
  assert.deepEqual(joined.enter, ["bia"]);
  assert.deepEqual(joined.exit, []);

  const dropped = nextPresence(joined, ["bia"], [], 3_000);
  assert.deepEqual(dropped.enter, []);
  assert.deepEqual(dropped.exit, []);

  const back = nextPresence(dropped, ["ana", "bia"], [], 4_000);
  assert.deepEqual(back.enter, []);
  assert.deepEqual(back.exit, []);

  const left = nextPresence(back, ["bia"], [], 100_000);
  assert.deepEqual(left.exit, []);
  const gone = nextPresence(left, ["bia"], [], 200_000);
  assert.deepEqual(gone.exit, ["ana"]);

  const stopped = nextPresence(gone, [], ["bia"], 201_000);
  assert.deepEqual(stopped.exit, ["bia"]);

  const again = nextPresence(stopped, ["bia"], [], 202_000);
  assert.deepEqual(again.enter, ["bia"]);
});

test("um salto para trás grande é o loop bugado", () => {
  assert.equal(playbackGlitch(20, 19), false);
  assert.equal(playbackGlitch(20, 16), true);
  assert.equal(playbackGlitch(0, 4), false);
});

test("quem já estava na lista não toca de novo quando outra pessoa abre o site", () => {
  assert.deepEqual(freshArrivals(["ana", "bia"], ["ana"]), ["bia"]);
  assert.deepEqual(freshArrivals(["ana"], ["ana"]), []);
});

test("o mesmo apelido não toca de novo por 3 minutos", () => {
  const first = dueChimes(["ana"], {}, 1_000);
  assert.deepEqual(first.play, ["ana"]);
  const again = dueChimes(["ana"], first.recent, 30_000);
  assert.deepEqual(again.play, []);
  const later = dueChimes(["ana", "bia"], again.recent, 200_000);
  assert.deepEqual(later.play, ["ana", "bia"]);
});

test("o som de entrada não cancela o de saída", () => {
  const enter = dueChimes(["enter:ana"], {}, 1_000);
  assert.deepEqual(enter.play, ["enter:ana"]);
  const exit = dueChimes(["exit:ana"], enter.recent, 30_000);
  assert.deepEqual(exit.play, ["exit:ana"]);
  const repeat = dueChimes(["enter:ana"], exit.recent, 40_000);
  assert.deepEqual(repeat.play, []);
});
