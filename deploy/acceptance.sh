#!/usr/bin/env bash
# Final acceptance run against the Docker Compose deployment (ROADMAP Phase 10):
#   1. builds and starts deploy/compose.yaml (+ compose.test.yaml) as project pmi-acceptance;
#   2. runs every acceptance suite in tests/central against the deployment's Postgres;
#   3. runs tests/compose: the containerized pmi-server behind Caddy over HTTPS, two CLI
#      machines, and a backup -> destroy -> restore drill;
#   4. tears everything down (volumes included).
# Needs Docker, Node 22, `npm ci && npm run build`.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/.." && pwd)"
work="$(mktemp -d)"
env_file="$work/acceptance.env"
cat > "$env_file" <<ENV
POSTGRES_PASSWORD=acceptance-$RANDOM$RANDOM
PMI_DOMAIN=localhost
PMI_HTTP_PORT=${PMI_ACC_HTTP_PORT:-18080}
PMI_HTTPS_PORT=${PMI_ACC_HTTPS_PORT:-18443}
PMI_PG_PORT=${PMI_ACC_PG_PORT:-55433}
PMI_METRICS_TOKEN=acceptance-metrics
PMI_BLOB_KEY=$(openssl rand -base64 32)
ENV
export PMI_COMPOSE_ARGS="-p pmi-acceptance -f $here/compose.yaml -f $here/compose.test.yaml --env-file $env_file"
compose() { docker compose $PMI_COMPOSE_ARGS "$@"; }
cleanup() { compose down -v >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT

compose up -d --build --wait
set -a; source "$env_file"; set +a
export PMI_TEST_PG_URL="postgres://pmi:${POSTGRES_PASSWORD}@127.0.0.1:${PMI_PG_PORT}/pmi"
export PMI_COMPOSE=1 PMI_COMPOSE_ENV_FILE="$env_file" PMI_COMPOSE_DIR="$here"

cd "$repo"
# One after the other: the drill in tests/compose replaces the database tests/central uses.
npx vitest run tests/central
npx vitest run tests/compose
echo "Acceptance run passed against the Compose deployment."
