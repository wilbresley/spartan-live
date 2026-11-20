#!/bin/sh
set -e
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "Falta o .env nesta pasta. Rode ./preparar.sh (ou ./instalar.sh) primeiro."
  exit 1
fi

# O segredo do /api/mtx-auth fica no .env; o container já carrega esse arquivo,
# então basta entrar nele. -T porque o script pode rodar sem terminal (ssh).
exec docker compose exec -T spartan-live-site node /app/admin-cli.mjs "$@"
