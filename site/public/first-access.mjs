// Página do link de primeiro acesso. É HTML puro de propósito: abre em qualquer
// celular, não depende do app.js e some da barra de endereço depois de concluir.
function escapeHtml(text) {
  return String(text || "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

export function renderFirstAccessPage(user, token) {
  const name = escapeHtml(user);
  const key = escapeHtml(token);
  return `<!DOCTYPE html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Spartan Live · primeiro acesso</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #3a3a3a; color: #ececec; font-family: "Segoe UI", sans-serif; padding: 24px; }
  form { width: min(380px, 100%); display: grid; gap: 12px; background: #2f2f2f; border: 1px solid #4a4a4a; border-radius: 14px; padding: 24px; }
  h1 { margin: 0 0 4px; font-size: 22px; }
  p { margin: 0; font-size: 14px; color: #b9b9b9; line-height: 1.4; }
  b { color: #ececec; }
  label { display: grid; gap: 6px; font-size: 13px; color: #c9c9c9; }
  input { width: 100%; padding: 12px; border-radius: 10px; border: 1px solid #555; background: #3a3a3a; color: #ececec; font-size: 16px; }
  input:focus { outline: 2px solid #6aa9ff; border-color: #6aa9ff; }
  button { padding: 13px; border: 0; border-radius: 10px; background: #4d8df0; color: #fff; font-size: 16px; font-weight: 600; cursor: pointer; }
  button:disabled { background: #3d5f92; cursor: default; }
  .erro { min-height: 18px; color: #ff9b9b; font-size: 13px; }
</style>
<main>
  <form id="form" autocomplete="on">
    <h1>Primeiro acesso</h1>
    <p>Oi, <b>${name}</b>. Escolha a senha que você vai usar para entrar e para transmitir.</p>
    <label>Senha
      <input id="senha" type="password" name="new-password" autocomplete="new-password" minlength="8" required>
    </label>
    <label>Repetir a senha
      <input id="senha2" type="password" name="confirm-password" autocomplete="new-password" minlength="8" required>
    </label>
    <div class="erro" id="erro" role="alert"></div>
    <button id="enviar" type="submit">Salvar e entrar</button>
  </form>
</main>
<script>
  const token = ${JSON.stringify(key)};
  const form = document.getElementById("form");
  const erro = document.getElementById("erro");
  const botao = document.getElementById("enviar");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    erro.textContent = "";
    const password = document.getElementById("senha").value;
    const again = document.getElementById("senha2").value;
    if (password !== again) {
      erro.textContent = "As duas senhas não estão iguais.";
      return;
    }
    botao.disabled = true;
    try {
      const response = await fetch("/api/first-access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ t: token, password, again }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        erro.textContent = data.error || "Não deu para salvar agora.";
        botao.disabled = false;
        return;
      }
      location.replace("/");
    } catch {
      erro.textContent = "Sem conexão com o servidor.";
      botao.disabled = false;
    }
  });
</script>`;
}
