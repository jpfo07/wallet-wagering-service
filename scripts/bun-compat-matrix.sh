#!/usr/bin/env bash
# Roda o mesmo checkout (install congelado, typecheck, testes unitários e de integração)
# em containers com versões diferentes do Bun, ligados à rede da stack de testes.
# Pré-requisito: bun run test:infra:up
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/test/.tmp/compat"
NETWORK="wws-test_default"
IMAGES=(
  "1.3.14|oven/bun:1.3.14-slim@sha256:621f249399228db47cf34611ee662585e77e015250ed29d5d0932b2d3282f0b0"
  "1.4.4|oven/bun:1.4.4-slim@sha256:13b43f8bb2c63f5d89c56205c4279b85620363296a00ada33ff7ad568f3688e7"
)

mkdir -p "$OUT"
docker network inspect "$NETWORK" >/dev/null 2>&1 || {
  echo "rede $NETWORK não encontrada: rode 'bun run test:infra:up' antes" >&2
  exit 2
}

run_in() {
  local version="$1" image="$2"
  docker run --rm --network "$NETWORK" \
    -v "$ROOT":/src:ro \
    -e EXPECTED_BUN_VERSION="$version" \
    -e TEST_DATABASE_HOST=postgres -e TEST_DATABASE_PORT=5432 \
    -e TEST_SQS_ENDPOINT=http://localstack:4566 \
    "$image" bash -c '
      set -u
      mkdir -p /work && cd /src && tar --exclude=./node_modules --exclude=./.git --exclude=./test/.tmp -cf - . | tar -xf - -C /work
      cd /work
      step() { local name="$1"; shift; local t0=$(date +%s%3N); "$@" >"/tmp/$name.log" 2>&1; local rc=$?; local t1=$(date +%s%3N);
               echo "[step] $name rc=$rc ms=$((t1 - t0))"; cat "/tmp/$name.log"; }
      echo "[runtime] bun=$(bun --version)"
      bun scripts/probes/glob-with-file-types.ts
      step install bun install --frozen-lockfile
      step typecheck bun run typecheck
      step unit bun test --timeout=30000 test/unit
      step integration bun test --timeout=30000 test/integration
      git_status=$(cd /work && cmp -s /src/bun.lock bun.lock && echo unchanged || echo CHANGED)
      echo "[lockfile] $git_status"
    '
}

printf "\n| Bun | install --frozen-lockfile | typecheck | unit | integration | api boot | fs.globSync withFileTypes | lockfile |\n|---|---|---|---|---|---|---|---|\n" >"$OUT/summary.md"
for entry in "${IMAGES[@]}"; do
  version="${entry%%|*}"
  image="${entry#*|}"
  log="$OUT/bun-$version.log"
  echo "==> Bun $version"
  run_in "$version" "$image" >"$log" 2>&1
  cell() { grep -m1 "^\[step\] $1 " "$log" | sed -E 's/.*rc=([0-9]+) ms=([0-9]+)/\1 \2/' | awk '{ printf "%s (%.1fs)", ($1 == 0 ? "ok" : "FALHOU rc=" $1), $2 / 1000 }'; }
  integ_summary=$(grep -E '^ *[0-9]+ (pass|fail)$' "$log" | tail -2 | tr -s ' ' | paste -sd' ' -)
  boot=$(grep -m1 -o 'api_boot_ms=[0-9]*' "$log" | cut -d= -f2)
  lock=$(grep -m1 '^\[lockfile\]' "$log" | cut -d' ' -f2)
  glob=$(grep -m1 -o 'glob_withFileTypes=[a-z]*' "$log" | cut -d= -f2)
  printf "| %s | %s | %s | %s | %s — %s | %s ms | %s | %s |\n" "$version" "$(cell install)" "$(cell typecheck)" "$(cell unit)" \
    "$(cell integration)" "$integ_summary" "${boot:-?}" "${glob:-?}" "${lock:-?}" >>"$OUT/summary.md"
done
cat "$OUT/summary.md"
echo
echo "logs completos em $OUT"
