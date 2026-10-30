#!/usr/bin/env bash
# Back up a PMI server deployed with deploy/compose.yaml:
#   deploy/backup.sh <output-dir> [compose args...]
# Writes db.dump (pg_dump custom format), blobs.tgz (the blob volume) and
# MANIFEST with SHA-256 of both. Safe while the server runs: pg_dump takes a
# consistent snapshot; blobs are immutable and content-addressed.
set -euo pipefail
out="${1:?usage: deploy/backup.sh <output-dir> [compose args...]}"
shift
here="$(cd "$(dirname "$0")" && pwd)"
compose=(docker compose -f "$here/compose.yaml" "$@")
mkdir -p "$out"
stamp="$(date -u +%Y-%m-%dT%H-%M-%SZ)"

"${compose[@]}" exec -T postgres pg_dump -U pmi -d pmi -Fc > "$out/db.dump"
"${compose[@]}" exec -T pmi-server tar -C /data -czf - blobs > "$out/blobs.tgz" 2>/dev/null \
  || "${compose[@]}" exec -T pmi-server sh -c 'mkdir -p /data/blobs && tar -C /data -czf - blobs' > "$out/blobs.tgz"
blobs="$("${compose[@]}" exec -T postgres psql -U pmi -d pmi -At -c 'SELECT count(*) FROM work.blobs')"

{
  echo "created_at=$stamp"
  echo "blob_rows=$blobs"
  (cd "$out" && shasum -a 256 db.dump blobs.tgz)
} > "$out/MANIFEST"
echo "Backup written to $out ($blobs blob rows)"
