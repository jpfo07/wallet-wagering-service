#!/usr/bin/env bash
# Smoke test da stack de dev (docker-compose.yml):
#   1. sobe tudo com --wait (healthchecks) e confere que as migrations saíram com 0;
#   2. confere réplicas e saúde de cada serviço;
#   3. 30 requisições pelo nginx precisam alcançar 3 instâncias distintas da API;
#   3b. /metrics: 404 pelo nginx, 200 dentro da API e de cada worker;
#   4. failover: derruba uma réplica, o nginx continua respondendo pelas outras; depois ela volta.
#      Da subida ao fim do failover, NENHUMA requisição pode falhar: as do script e as de um prober em
#      segundo plano (GET e um POST de leitura) são todas exigidas 2xx. A única espera é a do pool do
#      nginx convergir (DNS), e cada requisição dessa espera também precisa dar 2xx;
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
  [[ -n "${PROBE_STOP:-}" ]] && touch "$PROBE_STOP"
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

# Toda resposta não-2xx de qualquer requisição do smoke vai para cá; uma única linha reprova.
ERRORS=$(mktemp)
PROBE_STOP=$(mktemp -u)

# X-Instance-Id de n GETs. Uma resposta não-2xx é registrada (e reprova), nunca descartada.
instance_ids() {
  local n="$1" headers status
  for _ in $(seq "$n"); do
    headers=$(curl -sS -D - -o /dev/null --max-time 10 "$BASE_URL/health/live" | tr -d '\r') || true
    status=$(awk 'NR == 1 { print $2 }' <<<"$headers")
    if [[ "$status" != 2* ]]; then
      echo "$(date +%T.%3N) GET /health/live -> ${status:-sem resposta}" >>"$ERRORS"
      continue
    fi
    awk -F': ' 'tolower($1) == "x-instance-id" { print $2 }' <<<"$headers"
  done
}

assert_no_errors() {
  [[ ! -s "$ERRORS" ]] || fail "$1: requisições sem 2xx:"$'\n'"$(head -20 "$ERRORS")"
}

# Tráfego contínuo em segundo plano: GET e um POST de leitura (reconciliação), que o nginx não pode
# reenviar depois de enviado. Prova que nenhuma requisição se perde enquanto réplicas param e voltam.
start_prober() {
  local wallet="$1"
  rm -f "$PROBE_STOP"
  (
    while [[ ! -e "$PROBE_STOP" ]]; do
      for request in "GET /health/live" "POST /wallets/$wallet/reconciliation"; do
        status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X "${request%% *}" "$BASE_URL${request#* }") || true
        [[ "$status" == 2* ]] || echo "$(date +%T.%3N) $request -> ${status:-sem resposta}" >>"$ERRORS"
      done
    done
  ) &
  PROBER_PID=$!
}

stop_prober() {
  touch "$PROBE_STOP"
  wait "$PROBER_PID" 2>/dev/null || true
}

three_instances() { [[ "$(instance_ids 30 | sort -u | grep -c .)" == "3" ]]; }

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
# O pool do nginx segue o DNS (valid=1s): logo depois de um "up" que recriou as APIs ele pode ainda
# não ter os 3 IPs. Espera a convergência; cada requisição dela continua obrigada a dar 2xx.
wait_until 15 "nginx enxergar as 3 réplicas" three_instances
ids=$(instance_ids 30)
distinct=$(sort -u <<<"$ids" | grep -c . || true)
[[ "$distinct" == "3" ]] || fail "esperava 3 X-Instance-Id distintos em 30 requisições, vieram $distinct: $(sort -u <<<"$ids" | paste -sd' ')"
assert_no_errors "balanceamento"
echo "ok: 30 requisições atendidas por 3 instâncias ($(sort <<<"$ids" | uniq -c | awk '{ printf "%s=%s ", $2, $1 }'))"

ready=$(curl -fsS "$BASE_URL/health/ready")
[[ "$ready" == *'"postgres":"up"'* && "$ready" == *'"sqs":"up"'* ]] || fail "readiness inesperado: $ready"
echo "ok: /health/ready pelo nginx: $ready"

echo "==> /metrics só na rede interna"
for path in /metrics /metrics/ "/metrics?x=1"; do
  status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE_URL$path") || true
  [[ "$status" == "404" ]] || fail "GET $path pelo nginx deu ${status:-sem resposta}, esperado 404"
done
# Dentro do container o processo continua expondo as métricas (a API na 3000, os workers na 9100).
internal_metrics() {
  docker compose exec -T "$1" bun -e \
    "const r = await fetch('http://127.0.0.1:$2/metrics'); const t = await r.text(); if (r.status !== 200 || !t.includes('wws_')) process.exit(1)"
}
internal_metrics api 3000 || fail "/metrics da API não respondeu dentro do container"
for service in sqs-consumer outbox-publisher pending-reference-worker; do
  internal_metrics "$service" 9100 || fail "/metrics de $service não respondeu dentro do container"
done
echo "ok: /metrics 404 pelo nginx; 200 com séries wws_ dentro da API e dos 3 workers"

echo "==> failover: derrubando uma réplica da API (com tráfego GET e POST em segundo plano)"
wallet=$(curl -fsS -X POST "$BASE_URL/wallets" -H 'content-type: application/json' \
  -d "{\"playerId\":\"$(cat /proc/sys/kernel/random/uuid)\",\"initialBalance\":{\"amount\":\"10.00\",\"currency\":\"BRL\"}}" |
  sed -E 's/.*"id":"([^"]+)".*/\1/')
start_prober "$wallet"
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
wait_until 15 "nginx voltar a balancear entre 3 instâncias" three_instances
echo "ok: réplica voltou e o nginx balanceia entre 3 instâncias de novo"
stop_prober
assert_no_errors "failover e reintegração"
probes=$(docker compose logs --no-log-prefix nginx 2>/dev/null | grep -c '/reconciliation' || true)
echo "ok: nenhuma requisição sem 2xx durante o failover (prober: ${probes} POSTs pelo nginx)"

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
# próprio grace period e só precisam sair com 0. O limite é o maior prazo de desligamento dos
# processos (sqs-consumer: max(SQS_SHUTDOWN_DRAIN_MS, long poll) + 4s = 12s), abaixo do
# stop_grace_period (15s): o consumer espera de propósito o último long poll (até 5s, mais a latência
# do LocalStack com a stack inteira parando junto), então um limite menor reprovaria um desligamento
# correto. Um travamento continua aparecendo: passa do prazo ou sai com 137 (SIGKILL).
STOP_LIMIT_MS=12000
slowest_ms=0
for service in api sqs-consumer outbox-publisher pending-reference-worker nginx; do
  for container in $(docker compose ps -aq "$service"); do
    finished_ns=$(date -d "$(docker inspect --format '{{.State.FinishedAt}}' "$container")" +%s%N)
    took_ms=$(((finished_ns - started_ns) / 1000000))
    ((took_ms > slowest_ms)) && slowest_ms=$took_ms
    ((took_ms < STOP_LIMIT_MS)) || fail "$service ($container) levou ${took_ms}ms para parar (limite ${STOP_LIMIT_MS}ms)"
  done
done
echo "ok: $total containers com exit 0; aplicação parada em até ${slowest_ms}ms (stop total ${elapsed_ms}ms)"

echo "SMOKE OK"
