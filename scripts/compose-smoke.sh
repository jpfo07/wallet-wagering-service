#!/usr/bin/env bash
# Smoke test da stack de dev (docker-compose.yml):
#   1. sobe tudo com --wait (healthchecks) e confere que as migrations saíram com 0;
#   2. confere réplicas e saúde de cada serviço;
#   3. 30 requisições pelo nginx precisam alcançar 3 instâncias distintas da API;
#   4. failover: derruba uma réplica, o nginx continua respondendo pelas outras; depois ela volta.
# Uso: scripts/compose-smoke.sh [--down]   (--down derruba a stack e os volumes no fim, como no CI)
set -euo pipefail

cd "$(dirname "$0")/.."
BASE_URL="${BASE_URL:-http://localhost:8080}"
DOWN=false
[[ "${1:-}" == "--down" ]] && DOWN=true

fail() {
  echo "FALHOU: $*" >&2
  exit 1
}

on_exit() {
  local rc=$?
  if [[ $rc -ne 0 ]]; then
    echo "--- docker compose ps -a" >&2
    docker compose ps -a >&2 || true
    echo "--- últimos logs" >&2
    docker compose logs --tail=40 >&2 || true
  fi
  if $DOWN; then docker compose down -v --remove-orphans >/dev/null 2>&1 || true; fi
  exit $rc
}
trap on_exit EXIT

# Polling com timeout: espera uma condição, sem sleep arbitrário.
wait_until() {
  local timeout_s="$1" description="$2"
  shift 2
  local deadline=$((SECONDS + timeout_s))
  until "$@"; do
    ((SECONDS < deadline)) || fail "timeout (${timeout_s}s) esperando: $description"
    sleep 1
  done
}

instance_ids() {
  local n="$1"
  for _ in $(seq "$n"); do
    curl -fsS -D - -o /dev/null "$BASE_URL/health/live" | tr -d '\r' | awk -F': ' 'tolower($1) == "x-instance-id" { print $2 }'
  done
}

echo "==> subindo a stack"
docker compose up -d --build --wait --wait-timeout 240

echo "==> migrations"
migrations_exit=$(docker compose ps -a --format '{{.ExitCode}}' migrations)
[[ "$migrations_exit" == "0" ]] || fail "migrations saiu com $migrations_exit"
echo "ok: migrations exit 0"

echo "==> réplicas e saúde"
declare -A expected=([api]=3 [nginx]=1 [postgres]=1 [localstack]=1 [sqs-consumer]=2 [outbox-publisher]=2 [pending-reference-worker]=2)
for service in "${!expected[@]}"; do
  healthy=$(docker compose ps --format '{{.Health}}' "$service" | grep -c '^healthy$' || true)
  [[ "$healthy" == "${expected[$service]}" ]] || fail "$service: $healthy healthy, esperado ${expected[$service]}"
  echo "ok: $service ${healthy}/${expected[$service]} healthy"
done

echo "==> balanceamento pelo nginx"
ids=$(instance_ids 30)
distinct=$(sort -u <<<"$ids" | grep -c . || true)
[[ "$distinct" == "3" ]] || fail "esperava 3 X-Instance-Id distintos em 30 requisições, vieram $distinct: $(sort -u <<<"$ids" | paste -sd' ')"
echo "ok: 30 requisições atendidas por 3 instâncias ($(sort <<<"$ids" | uniq -c | awk '{ printf "%s=%s ", $2, $1 }'))"

ready=$(curl -fsS "$BASE_URL/health/ready")
[[ "$ready" == *'"postgres":"up"'* && "$ready" == *'"sqs":"up"'* ]] || fail "readiness inesperado: $ready"
echo "ok: /health/ready pelo nginx: $ready"

echo "==> failover: derrubando uma réplica da API"
victim=$(docker compose ps -q api | head -1)
victim_id=$(docker inspect --format '{{.Config.Hostname}}' "$victim")
docker stop "$victim" >/dev/null
ids=$(instance_ids 20)
grep -qx "$victim_id" <<<"$ids" && fail "réplica parada ($victim_id) ainda respondeu"
distinct=$(sort -u <<<"$ids" | grep -c . || true)
[[ "$distinct" == "2" ]] || fail "com uma réplica parada esperava 2 instâncias, vieram $distinct"
echo "ok: 20/20 requisições com sucesso pelas 2 réplicas restantes"

docker start "$victim" >/dev/null
is_healthy() { [[ "$(docker inspect --format '{{.State.Health.Status}}' "$victim")" == "healthy" ]]; }
wait_until 60 "réplica $victim_id voltar a healthy" is_healthy
three_again() { [[ "$(instance_ids 30 | sort -u | grep -c .)" == "3" ]]; }
wait_until 30 "nginx voltar a balancear entre 3 instâncias" three_again
echo "ok: réplica voltou e o nginx balanceia entre 3 instâncias de novo"

echo "SMOKE OK"
