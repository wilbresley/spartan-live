#!/bin/sh
set -e
cd "$(dirname "$0")"

if ! command -v openssl >/dev/null 2>&1; then
  echo "Precisa do openssl pra gerar as senhas."
  exit 1
fi

viewer_user="${VIEWER_USER:-spartan}"
session="$(openssl rand -hex 32)"
mtx_auth="$(openssl rand -hex 32)"
site_pass="$(openssl rand -hex 24)"

if [ -f .env ] && [ -f motor/mediamtx.yml ]; then
  echo ".env e motor/mediamtx.yml já existem. Não alterei senha nenhuma."
  if ! grep -q '^MTX_AUTH_SECRET=' .env; then
    echo
    echo "Este .env é de antes das contas por pessoa. Para cada um publicar com a própria conta:"
    echo "  1. acrescente MTX_AUTH_SECRET=\$(openssl rand -hex 32) no .env"
    echo "  2. em motor/mediamtx.yml, use authMethod: http e authHTTPAddress com esse segredo"
    echo "     (motor/mediamtx.yml.example mostra o bloco pronto)"
    echo "  3. ./subir.sh"
    echo "Sem esse segredo o motor não autoriza ninguém a publicar."
  fi
else
  if [ -f .env ] || [ -f motor/mediamtx.yml ]; then
    echo "Existe só um dos dois: .env ou motor/mediamtx.yml. Não gerei senha nova pra não dessincronizar."
    exit 1
  fi
  cat > .env <<EOF
VIEWER_USER=${viewer_user}
SESSION_SECRET=${session}
MTX_API_URL=http://spartan-live-motor:9997
MTX_HLS_URL=http://spartan-live-motor:8888
MTX_USER=site
MTX_PASSWORD=${site_pass}
MTX_AUTH_SECRET=${mtx_auth}
PORT=8080
# Endereço público do site, só para o ./admin-reset.sh montar a mensagem pronta:
# SITE_URL=https://spartanlive.exemplo.com
EOF
  sed \
    -e "s/TROQUE_SEGREDO_MOTOR/${mtx_auth}/" \
    motor/mediamtx.yml.example > motor/mediamtx.yml
  echo "Criei .env e motor/mediamtx.yml"
  echo "Admin da página: ${viewer_user}"
  echo "A senha inicial dele é sorteada na primeira subida do site e aparece uma vez:"
  echo "  docker compose logs spartan-live-site | grep 'Senha inicial'"
  echo "  (ou: docker exec spartan-live-site cat /app/data/admin-inicial.txt)"
  echo "Cada pessoa que for transmitir ganha uma conta própria em Pessoas → Contas de acesso, no site."
  echo "Esqueceu a senha do admin? ./admin-reset.sh link ${viewer_user}"
  echo "Com SITE_URL preenchido no .env, o ./admin-reset.sh imprime a mensagem pronta pra mandar no WhatsApp."
fi

if [ ! -f publisher/publish.json ]; then
  mkdir -p publisher
  cat > publisher/publish.json <<EOF
{
  "host": "",
  "port": 1935
}
EOF
  echo "Criei publisher/publish.json. O servidor fica em branco: cada pessoa escreve o IP ou o domínio no programa."
  echo "O programa novo não leva senha embutida: cada um digita o apelido e a senha da própria conta."
fi

echo
echo "Pronto. Agora: ./subir.sh"
echo "Guarde as senhas. Elas não entram no git."
