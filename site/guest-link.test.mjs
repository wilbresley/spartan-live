import assert from "node:assert/strict";
import test from "node:test";

import {
  createGuest,
  createPermanentGuest,
  findGuestInvite,
  guestActive,
  guestEndMessage,
  guestHours,
  guestRemainLabel,
  normalizeGuestStore,
  PERMANENT_HOLD_MS,
} from "./public/guest-link.mjs";

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
  assert.equal(guestEndMessage("revoked"), "Esse convite foi revogado. O link não está mais disponível.");
  assert.equal(guestEndMessage("expired"), "O tempo desse convite acabou. O link não está mais disponível.");
  assert.equal(guestEndMessage(""), "Esse link não existe mais.");
});

test("link permanente fica até revogar e convive com o temporário", () => {
  assert.equal(PERMANENT_HOLD_MS, 10_000);
  const permanent = createPermanentGuest("dddddddddddddddd", 1_000);
  assert.equal(permanent.kind, "permanent");
  assert.ok(permanent.exp > 1_000);
  const store = normalizeGuestStore({
    temporary: createGuest(3, 1_000, "eeeeeeeeeeeeeeee"),
    permanent,
  }, 2_000);
  assert.equal(store.temporary.id, "eeeeeeeeeeeeeeee");
  assert.equal(store.permanent.id, "dddddddddddddddd");
  assert.equal(findGuestInvite(store, "dddddddddddddddd", 2_000).kind, "permanent");
  assert.equal(findGuestInvite(store, "eeeeeeeeeeeeeeee", 2_000).kind, "temporary");
  const legacy = normalizeGuestStore(createGuest(6, 1_000, "ffffffffffffffff"), 2_000);
  assert.equal(legacy.temporary.id, "ffffffffffffffff");
  assert.equal(legacy.permanent, null);
});
