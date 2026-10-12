#!/bin/sh
set -e
cd "$(dirname "$0")"

if ! command -v openssl >/dev/null 2>&1; then
  echo "Precisa do openssl pra gerar as senhas."
  exit 1
fi

viewer_user="${VIEWER_USER:-spartan}"
session="$(openssl rand -hex 32)"
publisher_pass="$(openssl rand -hex 24)"
site_pass="$(openssl rand -hex 24)"

if [ -f .env ] && [ -f motor/mediamtx.yml ]; then
  echo ".env e motor/mediamtx.yml já existem. Não alterei senha nenhuma."
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
PUBLISH_USER=publisher
PUBLISH_PASSWORD=${publisher_pass}
PORT=8080
EOF
  sed \
    -e "s/TROQUE_SENHA_PUBLISHER/${publisher_pass}/" \
    -e "s/TROQUE_SENHA_SITE/${site_pass}/" \
    motor/mediamtx.yml.example > motor/mediamtx.yml
  echo "Criei .env e motor/mediamtx.yml"
  echo "Login da página: ${viewer_user}"
  echo "Senha da página: spartanadmin"
  echo "Na primeira entrada o site pede uma senha nova."
  echo "Senha do programa de transmitir: ${publisher_pass}"
  if [ ! -f publisher/publish.json ]; then
    cat > publisher/publish.json <<EOF
{
  "host": "",
  "port": 1935,
  "user": "publisher",
  "password": "${publisher_pass}"
}
EOF
    echo "Criei publisher/publish.json. O servidor fica em branco: cada pessoa escreve o IP ou o domínio no programa."
  fi
fi

echo
echo "Pronto. Agora: ./subir.sh"
echo "Guarde as senhas. Elas não entram no git."
