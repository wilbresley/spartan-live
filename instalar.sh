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

echo
echo "Spartan Live está no ar."
echo "Abre no navegador: http://IP-DESTE-SERVIDOR:8097"
echo "Login: spartan"
echo "Senha: spartanadmin"
echo "Na primeira entrada o site pede uma senha nova."
echo "Se essa senha for esquecida, apaga os dados e reinstala: docker compose down -v && ./instalar.sh"
