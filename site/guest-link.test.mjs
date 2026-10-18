import assert from "node:assert/strict";
import test from "node:test";

import { createGuest, guestActive, guestHours, guestRemainLabel } from "./public/guest-link.mjs";

test("o convite só aceita 3, 6, 12 ou 24 horas e o endereço não se repete", () => {
  assert.equal(guestHours(12), 12);
  assert.equal(guestHours(1), 0);
  assert.equal(guestHours("24"), 24);
  const first = createGuest(12, 1_000, "aaaaaaaaaaaaaaaa");
  const second = createGuest(3, 1_000, "bbbbbbbbbbbbbbbb");
  assert.equal(first.exp, 1_000 + 12 * 60 * 60 * 1000);
  assert.notEqual(first.id, second.id);
  assert.equal(createGuest(5, 1_000, "aaaaaaaaaaaaaaaa"), null);
  assert.equal(createGuest(6, 1_000, "curto"), null);
});

test("convite vencido some e o relógio mostra o que falta", () => {
  const invite = createGuest(6, 0, "cccccccccccccccc");
  assert.equal(guestActive(invite, invite.exp - 1).id, invite.id);
  assert.equal(guestActive(invite, invite.exp), null);
  assert.equal(guestRemainLabel(invite.exp, invite.exp - (11 * 3600 + 42 * 60) * 1000), "11h 42min");
  assert.equal(guestRemainLabel(90_000, 0), "1min 30s");
  assert.equal(guestRemainLabel(5_000, 0), "5s");
});
