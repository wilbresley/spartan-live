import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  ROLE_ADMIN,
  ROLE_USER,
  accountLink,
  deleteBlocked,
  nameProblem,
  normalizeName,
  roleLabel,
  shortDate,
  sortUsers,
  userState,
} from "./public/users-ui.mjs";

test("nome da conta é minúsculo e precisa de 2 a 24 letras, números, _ ou -", () => {
  assert.equal(normalizeName("  Ana  "), "ana");
  assert.equal(nameProblem("Ana"), "");
  assert.equal(nameProblem("ana_2"), "");
  assert.equal(nameProblem(""), "Digite o nome da conta.");
  assert.equal(nameProblem("   "), "Digite o nome da conta.");
  assert.match(nameProblem("a"), /2 a 24/);
  assert.match(nameProblem("ana silva"), /2 a 24/);
  assert.match(nameProblem("joão"), /2 a 24/);
  assert.match(nameProblem("x".repeat(25)), /2 a 24/);
});

test("papel da conta aparece em português", () => {
  assert.equal(roleLabel(ROLE_ADMIN), "Admin");
  assert.equal(roleLabel(ROLE_USER), "Usuário");
  assert.equal(roleLabel(""), "Usuário");
});

test("estado da conta mostra senha, convite valendo ou convite vencido", () => {
  const now = new Date(2026, 10, 20, 12).getTime();
  const exp = new Date(2026, 10, 26, 12).getTime();
  assert.deepEqual(userState({ user: "ana", hasPassword: true }, now), { kind: "ready", label: "senha definida" });
  assert.deepEqual(userState({ user: "ana", hasPassword: true, mustChange: true }, now), {
    kind: "pending",
    label: "troca de senha pendente",
  });
  assert.deepEqual(userState({ user: "ana", hasPassword: false, firstAccessExp: exp }, now), {
    kind: "invite",
    label: "convite até 26/11",
  });
  assert.deepEqual(userState({ user: "ana", hasPassword: false, firstAccessExp: 0 }, now), {
    kind: "waiting",
    label: "convite vencido",
  });
  assert.deepEqual(userState({ user: "ana", firstAccessExp: now - 1 }, now), { kind: "waiting", label: "convite vencido" });
  assert.deepEqual(userState(null, now), { kind: "waiting", label: "convite vencido" });
  assert.equal(shortDate("nada"), "");
});

test("lista põe admin primeiro e depois ordem alfabética", () => {
  const rows = sortUsers([
    { user: "bruno", role: ROLE_USER },
    { user: "spartan", role: ROLE_ADMIN },
    { user: "ana", role: ROLE_USER },
    { user: "zeca", role: ROLE_ADMIN },
    null,
  ]);
  assert.deepEqual(rows.map((row) => row.user), ["spartan", "zeca", "ana", "bruno"]);
  assert.deepEqual(sortUsers("nada"), []);
});

test("link de primeiro acesso vira URL absoluta ou vazio", () => {
  const token = "a".repeat(43);
  assert.equal(accountLink("https://live.exemplo.com", `/p/${token}`), `https://live.exemplo.com/p/${token}`);
  assert.equal(accountLink("https://live.exemplo.com", `/p/${token}?x=1`), "");
  assert.equal(accountLink("https://live.exemplo.com", "/api/admin/users"), "");
  assert.equal(accountLink("https://live.exemplo.com", ""), "");
});

test("exclusão é travada na própria conta e no último admin", () => {
  const users = [
    { user: "spartan", role: ROLE_ADMIN },
    { user: "ana", role: ROLE_USER },
  ];
  assert.equal(deleteBlocked({ user: "ana", role: ROLE_USER }, "spartan", users), "");
  assert.match(deleteBlocked({ user: "spartan", role: ROLE_ADMIN }, "spartan", users), /própria conta/);
  assert.match(deleteBlocked({ user: "zeca", role: ROLE_ADMIN }, "spartan", [{ user: "zeca", role: ROLE_ADMIN }]), /último admin/);
  assert.equal(
    deleteBlocked({ user: "zeca", role: ROLE_ADMIN }, "spartan", [
      { user: "spartan", role: ROLE_ADMIN },
      { user: "zeca", role: ROLE_ADMIN },
    ]),
    "",
  );
  assert.match(deleteBlocked({ user: "" }, "spartan", users), /Conta inválida/);
});

test("index.html e app.js ligam o diálogo de contas ao menu de Pessoas", () => {
  const html = fs.readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
  assert.match(html, /id="m-set-users"/);
  assert.match(html, /id="users-create"/);
  assert.match(html, /id="users-link-copy"/);
  assert.match(html, /id="users-empty"/);

  const app = fs.readFileSync(new URL("./public/app.js", import.meta.url), "utf8");
  assert.match(app, /from "\.\/users-ui\.mjs"/);
  assert.match(app, /"\/api\/admin\/users"/);
  assert.match(app, /function openUsers\(\)/);
  assert.match(app, /function closeUsers\(\)/);
  assert.match(app, /querySelector\("#m-set-users"\)\?\.addEventListener\("click", openUsers\)/);
});

