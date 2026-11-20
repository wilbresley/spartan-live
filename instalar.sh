#!/bin/sh
set -e
cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "O Docker não está instalado."
  echo "No Debian/Ubuntu: sudo apt update && sudo apt install -y docker.io docker-compose-v2"
  echo "Depois entra de novo no servidor e roda este script outra vez."
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Falta o comando: docker compose"
  echo "No Debian/Ubuntu: sudo apt install -y docker-compose-v2"
  exit 1
fi

./preparar.sh
docker compose up -d --build

admin_user="$(sed -n 's/^VIEWER_USER=//p' .env | head -n1)"
[ -n "$admin_user" ] || admin_user=spartan

echo
echo "Spartan Live está no ar."
echo "Abre no navegador: http://IP-DESTE-SERVIDOR:8097"
echo "Admin da página: ${admin_user} (a senha inicial aparece no log do site, uma vez)"
echo "  docker compose logs spartan-live-site | grep 'Senha inicial'"
echo "Esqueceu a senha? ./admin-reset.sh link ${admin_user}"
