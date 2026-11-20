#!/bin/sh
set -e
cd "$(dirname "$0")"

if [ ! -f .env ] || [ ! -f motor/mediamtx.yml ]; then
  echo "Faltam .env ou motor/mediamtx.yml nesta pasta."
  exit 1
fi

docker compose up -d --build
echo
docker compose ps
echo
echo "Site:  http://$(hostname -I | awk '{print $1}'):8097"
echo "RTMP:  porta 1935"
