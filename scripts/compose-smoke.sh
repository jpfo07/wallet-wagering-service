#!/usr/bin/env bash
# Smoke test da stack de dev (docker-compose.yml):
#   1. sobe tudo com --wait (healthchecks) e confere que as migrations saíram com 0;
#   2. confere réplicas e saúde de cada serviço;
#   3. 30 requisições pelo nginx precisam alcançar 3 instâncias distintas da API;
#   4. failover: derruba uma réplica, o nginx continua respondendo pelas outras; depois ela volta;
#   5. SIGTERM durante o boot de um worker: para em poucos segundos com 0 ou 143, nunca 137 (SIGKILL);
#   6. desligamento: `docker compose stop` com a stack saudável, todos os containers saem com 0.
# Uso: scripts/compose-smoke.sh [--down]   (no fim a stack fica parada; --down também a remove com os
# volumes, como no CI)
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

echo "==> SIGTERM durante o boot de um worker"
worker=$(docker compose ps -q sqs-consumer | head -1)
docker restart "$worker" >/dev/null # volta assim que o container inicia, com o boot em andamento
started_ns=$(date +%s%N)
docker stop -t 15 "$worker" >/dev/null
elapsed_ms=$((($(date +%s%N) - started_ns) / 1000000))
worker_exit=$(docker inspect --format '{{.State.ExitCode}}' "$worker")
# 0: handler já instalado; 143: tini repassou o SIGTERM antes do handler existir; 137: SIGKILL.
[[ "$worker_exit" == "0" || "$worker_exit" == "143" ]] || fail "worker parado no boot saiu com $worker_exit"
((elapsed_ms < 5000)) || fail "worker parado no boot levou ${elapsed_ms}ms (limite 5000ms)"
echo "ok: worker parado no boot saiu com $worker_exit em ${elapsed_ms}ms"
docker start "$worker" >/dev/null
worker_healthy() { [[ "$(docker inspect --format '{{.State.Health.Status}}' "$worker")" == "healthy" ]]; }
wait_until 60 "worker voltar a healthy" worker_healthy

echo "==> desligamento: todos os serviços param com exit 0"
started_ns=$(date +%s%N)
docker compose stop >/dev/null 2>&1
elapsed_ms=$((($(date +%s%N) - started_ns) / 1000000))
exits=$(docker compose ps -a --format '{{.Name}} {{.ExitCode}}')
bad=$(awk '$2 != "0"' <<<"$exits")
[[ -z "$bad" ]] || fail "containers que não saíram com 0: $(paste -sd' ' <<<"$bad")"
total=$(grep -c . <<<"$exits")
[[ "$total" == "13" ]] || fail "esperava 13 containers parados (12 serviços + migrations), vieram $total"
# Prazo só para os nossos processos (param primeiro, por dependência); Postgres e LocalStack têm o
# próprio grace period e só precisam sair com 0.
slowest_ms=0
for service in api sqs-consumer outbox-publisher pending-reference-worker nginx; do
  for container in $(docker compose ps -aq "$service"); do
    finished_ns=$(date -d "$(docker inspect --format '{{.State.FinishedAt}}' "$container")" +%s%N)
    took_ms=$(((finished_ns - started_ns) / 1000000))
    ((took_ms > slowest_ms)) && slowest_ms=$took_ms
    ((took_ms < 8000)) || fail "$service ($container) levou ${took_ms}ms para parar (limite 8000ms)"
  done
done
echo "ok: $total containers com exit 0; aplicação parada em até ${slowest_ms}ms (stop total ${elapsed_ms}ms)"

echo "SMOKE OK"
