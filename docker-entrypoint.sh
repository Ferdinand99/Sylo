#!/bin/sh
# Sylo container entrypoint.
#
# A bind-mounted data directory (e.g. Unraid's /mnt/user/appdata/sylo/data) is
# created by the Docker host as root, which the unprivileged runtime user can't
# write to. When started as root, fix ownership of the data directory and then
# drop privileges so the Node process still runs as a non-root user.
set -e

DATA_DIR=$(dirname "${DATABASE_PATH:-/app/data/sylo.db}")

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR" /app/data
  chown -R sylo:sylo "$DATA_DIR" /app/data 2>/dev/null || true
  exec su-exec sylo:sylo "$@"
fi

# Already unprivileged (e.g. run with --user): just exec.
exec "$@"
