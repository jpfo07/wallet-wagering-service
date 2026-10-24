#!/usr/bin/env bash
# Roda as migrations DENTRO da imagem construída (instalada com --production) contra o
# Postgres da stack de testes. Evita o caso em que o host funciona por causa de uma
# devDependency e a imagem não (ex.: tinyglobby, usado pelo migrator do MikroORM).
#   1. migrations reais do repositório: up -> down -> up num banco novo;
#   2. descoberta de arquivos: uma migration de sonda montada no lugar da pasta de migrations.
# Uso: scripts/image-migrations-check.sh [imagem]   (pré-requisito: bun run test:infra:up)
set -euo pipefail

cd "$(dirname "$0")/.."
IMAGE="${1:-wallet-wagering-service:dev}"
NETWORK="wws-test_default"
DB="wws_image_check_$$"
PROBE_DIR="$(mktemp -d)"

psql_admin() { docker compose -f docker-compose.test.yml exec -T postgres psql -U wallet -d postgres -qtAc "$1"; }
cleanup() {
  psql_admin "drop database if exists $DB with (force)" >/dev/null 2>&1 || true
  rm -rf "$PROBE_DIR"
}
trap cleanup EXIT

migrate() {
  docker run --rm --network "$NETWORK" \
    -e DATABASE_HOST=postgres -e DATABASE_NAME="$DB" -e DATABASE_USER=wallet -e DATABASE_PASSWORD=wallet \
    "$@"
}

psql_admin "create database $DB" >/dev/null

echo "==> migrations do repositório na imagem $IMAGE"
for command in up down up; do
  migrate "$IMAGE" bun run src/entrypoints/migrate.ts "$command"
done

echo "==> descoberta de arquivos de migration na imagem"
psql_admin "drop database $DB with (force)" >/dev/null
psql_admin "create database $DB" >/dev/null
cat >"$PROBE_DIR/Migration20000101000000_image_probe.ts" <<'EOF'
import { Migration } from "@mikro-orm/migrations";
export class Migration20000101000000_image_probe extends Migration {
  override up(): void { this.addSql("create table image_probe (id integer primary key)"); }
  override down(): void { this.addSql("drop table image_probe"); }
}
EOF
chmod -R a+rX "$PROBE_DIR"
output=$(migrate -v "$PROBE_DIR:/app/src/infrastructure/persistence/migrations:ro" "$IMAGE" \
  bun run src/entrypoints/migrate.ts up 2>&1)
echo "$output"
grep -q "applied 1 migration(s): Migration20000101000000_image_probe" <<<"$output" ||
  { echo "FALHOU: a imagem não descobriu/aplicou a migration de sonda" >&2; exit 1; }

echo "IMAGE MIGRATIONS OK"
