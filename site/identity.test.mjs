import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { capitalizeName, identityLabel } from "./public/identity-label.mjs";

test("conta admin aparece como Admin e conta comum com a primeira letra maiúscula", () => {
  assert.equal(identityLabel({ role: "admin", user: "spartan" }), "Admin");
  assert.equal(identityLabel({ role: "user", user: "bresley" }), "Bresley");
  assert.equal(identityLabel({ role: "user", user: "  ana_2  " }), "Ana_2");
  assert.equal(identityLabel({ role: "user", user: "" }), "");
  assert.equal(identityLabel({ role: "", user: "bresley" }), "");
  assert.equal(identityLabel(null), "");
  assert.equal(capitalizeName(""), "");
});

test("convidado mostra Temp ou Perm com o apelido escolhido", () => {
  assert.equal(identityLabel({ role: "guest", kind: "temporary", accessId: 2 }, "Adi"), "Convidado - Temp - Adi");
  assert.equal(identityLabel({ role: "guest", kind: "permanent", accessId: 3 }, "Adi"), "Convidado - Perm - Adi");
  assert.equal(identityLabel({ role: "guest", accessId: 3 }, "Adi"), "Convidado - Perm - Adi");
  assert.equal(identityLabel({ role: "guest", accessId: 2 }, "  Adi  "), "Convidado - Temp - Adi");
  assert.equal(identityLabel({ role: "guest", kind: "temporary" }, ""), "Convidado - Temp");
});

test("index.html e app.js têm o nome ao lado da engrenagem e o apelido só do convidado", () => {
  const html = fs.readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
  assert.match(html, /id="whoami"/);
  assert.match(html, /id="m-who"/);
  assert.ok(html.indexOf('id="whoami"') < html.indexOf('id="settings"'), "nome antes da engrenagem no PC");
  assert.ok(html.indexOf('id="m-who"') < html.indexOf('id="m-gear"'), "nome antes da engrenagem no celular");

  const app = fs.readFileSync(new URL("./public/app.js", import.meta.url), "utf8");
  assert.match(app, /from "\.\/identity-label\.mjs"/);
  assert.match(app, /function paintWhoami\(\)/);
  assert.match(app, /function applyViewer\(me\)/);
  assert.match(app, /if \(viewerRole === "guest"\) \{/);
  assert.match(app, /rememberNick\(viewerUser, "account"\)/);

  const server = fs.readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  assert.match(server, /"\/identity-label\.mjs": \{ file: "identity-label\.mjs"/, "o site precisa entregar o módulo");
});

test("sair fecha o painel de ajustes e os avisos abertos", () => {
  const app = fs.readFileSync(new URL("./public/app.js", import.meta.url), "utf8");
  const showLogin = app.slice(app.indexOf("function showLogin()"), app.indexOf("function showPasswordGate()"));
  assert.match(showLogin, /closeMobileSettings\(\)/);
  assert.match(showLogin, /closeMobileDrawer\(\)/);
  assert.match(showLogin, /unmountMobile\(\)/);
  assert.match(showLogin, /settingsPop\?\.classList\.add\("hidden"\)/);
  assert.match(showLogin, /#password-ask"\)\?\.classList\.add\("hidden"\)/);
  assert.match(showLogin, /#download-ask"\)\?\.classList\.add\("hidden"\)/);
  assert.match(showLogin, /viewerUser = ""/);
});
