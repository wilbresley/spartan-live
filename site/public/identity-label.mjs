// Quem está logado aparece no topo, à esquerda da engrenagem. Conta com papel de
// admin mostra "Admin"; conta comum mostra o nome da conta com a primeira letra
// maiúscula; convidado mostra o crachá do convite e o apelido que ele escolheu.
export function capitalizeName(name) {
  const text = String(name || "").trim();
  if (!text) return "";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function identityLabel(me = {}, nick = "") {
  const role = me?.role;
  if (role === "admin") return "Admin";
  if (role === "user") return capitalizeName(me.user);
  if (role !== "guest") return "";
  const permanent = me.kind === "permanent" || Number(me.accessId) === 3;
  const badge = permanent ? "Convidado - Perm" : "Convidado - Temp";
  const chosen = String(nick || "").trim();
  return chosen ? `${badge} - ${chosen}` : badge;
}
