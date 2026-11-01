#!/usr/bin/env bash
# Restore a backup made by deploy/backup.sh into the compose deployment:
#   deploy/restore.sh <backup-dir> [compose args...]
# Verifies the backup checksums, replaces the database and the blob volume,
# then checks every blob against its SHA-256 (baton-server verify-blobs).
# The current database is dumped to <backup-dir>/pre-restore.dump first.
set -euo pipefail
src="${1:?usage: deploy/restore.sh <backup-dir> [compose args...]}"
shift
here="$(cd "$(dirname "$0")" && pwd)"
compose=(docker compose -f "$here/compose.yaml" "$@")

(cd "$src" && grep -E '^[0-9a-f]{64}  ' MANIFEST | shasum -a 256 -c -)

"${compose[@]}" up -d --wait postgres
"${compose[@]}" exec -T postgres pg_dump -U baton -d baton -Fc > "$src/pre-restore.dump" || true
"${compose[@]}" stop baton-server

# baton_app is a cluster-wide role, not part of a database dump.
"${compose[@]}" exec -T postgres psql -U baton -d postgres -v ON_ERROR_STOP=1 -c \
  "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'baton_app') THEN CREATE ROLE baton_app NOLOGIN; END IF; END \$\$;"
"${compose[@]}" exec -T postgres psql -U baton -d postgres -v ON_ERROR_STOP=1 -c 'DROP DATABASE IF EXISTS baton WITH (FORCE)' -c 'CREATE DATABASE baton'
"${compose[@]}" exec -T postgres pg_restore -U baton -d baton --no-owner --exit-on-error < "$src/db.dump"

"${compose[@]}" run --rm --no-deps -T --entrypoint sh baton-server -c 'rm -rf /data/blobs && tar -C /data -xzf -' < "$src/blobs.tgz"
"${compose[@]}" up -d --wait baton-server
"${compose[@]}" exec -T baton-server node dist/server/central/main.js verify-blobs
echo "Restored from $src"
