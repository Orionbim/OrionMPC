#!/bin/sh
set -eu
# A fresh Railway volume is owned by root. Restrict initialization to our mount.
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data
  chown node:node /data
  chmod 700 /data
  exec setpriv --reuid=node --regid=node --init-groups node dist/server/http.js
fi
exec node dist/server/http.js
