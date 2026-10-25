# wallet-wagering-service

Serviço financeiro distribuído que processa transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK)
vindas de vários provedores, por HTTP e por SQS. Mantém o saldo de cada wallet e um ledger
append-only, com idempotência persistente, e é correto com várias instâncias rodando ao mesmo tempo.

```
postgres ──► migrations (roda uma vez) ──┐
localstack (filas SQS) ──────────────────┼──► api ×3 ──► nginx :8080
                                         └──► sqs-consumer ×2 · outbox-publisher ×2 · pending-reference-worker ×2
```

Stack: Bun 1.3.14, TypeScript estrito, NestJS, MikroORM, PostgreSQL 18, SQS via LocalStack 4.14,
`decimal.js` (encapsulado em `Money`), pino e prom-client.

As decisões, os trade-offs, as interpretações de regra e as limitações estão no
[ARCHITECTURE.md](ARCHITECTURE.md).

## Pré-requisitos

- **Docker** com **Compose v2** (comando `docker compose`).
- **Bun 1.3.14** (a versão exata está em `.bun-version`): `curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.14"`.
- **Memória para o Docker: recomendado 6 GiB; testado com 4,8 GiB.** A stack de dev tem 13
  containers; o teste ponta a ponta sobe 7 processos da aplicação ao lado da stack de testes. No
  WSL2, o limite fica em `%UserProfile%\.wslconfig` (`[wsl2]` → `memory=6GB`).
- Portas livres: `8080` (nginx), `127.0.0.1:5432` e `127.0.0.1:4566` (stack de dev); `55432` e
  `54566` (stack de testes).
- Para os exemplos de fila: AWS CLI v2, ou nada, usando o `awslocal` de dentro do container do
  LocalStack (os dois aparecem abaixo).

Dica: suba **uma stack por vez** (dev ou testes) e rode **uma suíte de teste por vez**. As duas stacks
juntas, mais uma suíte de concorrência, apertam uma máquina com pouca memória.

## Setup do zero

```bash
git clone <url-do-repositório> wallet-wagering-service
cd wallet-wagering-service
bun install --frozen-lockfile
```

O `.env` só é necessário para rodar processos fora do compose (`cp .env.example .env`; o Bun carrega
o `.env` automaticamente). O compose e os testes já têm os valores certos.

## Subir a stack

```bash
docker compose up -d --build --wait   # migrations, 3 APIs atrás do nginx, workers ×2
curl -s localhost:8080/health/ready   # {"status":"ok","checks":{"postgres":"up","sqs":"up"}}
docker compose down                   # -v também apaga o volume do PostgreSQL
```

Prova automatizada (a mesma do CI): `bun run compose:smoke --down` sobe tudo do zero e confere a
saúde e o número de réplicas, o balanceamento entre 3 instâncias, o failover sem nenhuma resposta
fora de 2xx, o `/metrics` fora do nginx e o desligamento com exit 0. No fim, derruba a stack.
**Atenção:** ele começa com `docker compose down -v`, então apaga o volume do PostgreSQL de dev.

## Testes

Os testes de integração e de concorrência usam **PostgreSQL e LocalStack reais**, numa stack
própria (`docker-compose.test.yml`, projeto `wws-test`). Nada é mockado.

```bash
docker compose down                 # libera memória: a stack de dev não é usada pelos testes
bun run test:infra:up               # Postgres :55432 e LocalStack :54566

bun run test:unit                   # domínio, aplicação e adaptadores; não precisa de containers
bun run test:integration            # schema, use cases, API HTTP, consumidor SQS, workers
bun run test:concurrency            # corridas reais, processos separados, crash e reinício

bun run test:infra:down             # derruba e apaga os volumes
```

`bun run test` roda tudo de uma vez, mas uma suíte por vez é mais previsível em máquinas pequenas.

Qualidade (também no CI):

```bash
bun run format:check && bun run lint && bun run typecheck
```

### Teste de carga

Roda contra a **stack de dev** (sem a de testes no ar):

```bash
docker compose up -d --build --wait
bun run test:load
docker compose down
```

O teste imprime throughput, p50/p95/p99, taxa de erro, conflitos de lock, retries e outbox lag para
dois perfis (500 wallets e hot wallet) e grava o resultado em `scripts/load-results/`. A metodologia e
a análise de uma execução estão no ARCHITECTURE.md.

## Usando a API

Todos os exemplos usam o nginx (`http://localhost:8080`). Dinheiro é sempre string com 2 casas:
`{"amount":"25.00","currency":"BRL"}`.

```bash
API=http://localhost:8080
PLAYER=$(cat /proc/sys/kernel/random/uuid)   # ou uuidgen

# 1. Criar a wallet (201)
WALLET=$(curl -s -X POST $API/wallets -H 'content-type: application/json' \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}" |
  sed -E 's/.*"id":"([^"]+)".*/\1/')
echo $WALLET

# 2. BET (200, status PROCESSED, idempotentReplay false)
BET="{\"providerId\":\"acme\",\"externalTransactionId\":\"bet-1\",\"playerId\":\"$PLAYER\",
  \"walletId\":\"$WALLET\",\"roundId\":\"round-1\",\"gameId\":\"slots\",\"kind\":\"BET\",
  \"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"
curl -s -X POST $API/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: acme:bet-1' -d "$BET"

# 3. Replay: a mesma requisição devolve a mesma resposta, com idempotentReplay true, sem novo débito
curl -s -X POST $API/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: acme:bet-1' -d "$BET"

# 4. Mesma chave com outro payload: 409 IDEMPOTENCY_KEY_REUSED
curl -s -X POST $API/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: acme:bet-1' -d "${BET/25.00/30.00}"

# 5. WIN referenciando a BET
curl -s -X POST $API/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: acme:win-1' \
  -d "{\"providerId\":\"acme\",\"externalTransactionId\":\"win-1\",\"playerId\":\"$PLAYER\",
  \"walletId\":\"$WALLET\",\"roundId\":\"round-1\",\"gameId\":\"slots\",\"kind\":\"WIN\",
  \"money\":{\"amount\":\"40.00\",\"currency\":\"BRL\"},\"referenceExternalTransactionId\":\"bet-1\"}"

# 6. Wallet, ledger (paginado por cursor) e transação pelo id do provedor
curl -s $API/wallets/$WALLET
curl -s "$API/wallets/$WALLET/ledger?limit=2"     # nextCursor → ?cursor=<valor>
curl -s $API/providers/acme/wagering/transactions/bet-1

# 7. Reconciliação: saldo materializado × saldo reconstruído pelo ledger
curl -s -X POST $API/wallets/$WALLET/reconciliation
```

Os ids `bet-1`, `win-1` e `bet-2` são únicos por provedor: rodar os exemplos de novo, com outra
wallet, devolve 409 (conflito de idempotência). Para repetir, troque os ids ou o
`providerId`, ou recrie o banco com `docker compose down -v`.

Status da submissão: 200 PROCESSED, 202 PENDING_REFERENCE (a referência ainda não chegou), 422
REJECTED (rejeição de negócio, com `failureCode`), 409 conflito de idempotência, 400 forma inválida e
503 com `Retry-After` (falha transitória: pode reenviar a mesma requisição). A tabela completa está no
ARCHITECTURE.md.

Cada resposta traz `X-Correlation-Id` (o enviado pelo cliente, ou um gerado), `X-Instance-Id` (a
réplica da API) e `X-Upstream-Addr` (definido pelo nginx).

## Enviando uma transação pela fila

Fila de entrada: `wager-transactions.fifo` (DLQ `wager-transactions-dlq.fifo`). O `data` é o mesmo
corpo do HTTP, mais `idempotencyKey`. `MessageGroupId` = `walletId`.

```bash
MSG_ID=$(cat /proc/sys/kernel/random/uuid)
BODY="{\"messageId\":\"$MSG_ID\",\"type\":\"WagerTransactionRequested\",
  \"occurredAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"data\":{\"providerId\":\"acme\",
  \"externalTransactionId\":\"bet-2\",\"idempotencyKey\":\"acme:bet-2\",\"playerId\":\"$PLAYER\",
  \"walletId\":\"$WALLET\",\"roundId\":\"round-2\",\"gameId\":\"slots\",\"kind\":\"BET\",
  \"money\":{\"amount\":\"10.00\",\"currency\":\"BRL\"}}}"

# Sem AWS CLI no host: awslocal de dentro do container
docker compose exec -T localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id "$WALLET" --message-deduplication-id "$MSG_ID" --message-body "$BODY"

# Com AWS CLI v2 no host
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1 \
  aws --endpoint-url http://localhost:4566 sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id "$WALLET" --message-deduplication-id "$MSG_ID" --message-body "$BODY"

# Resultado: 404 até o consumidor processar (poucos segundos), depois a transação
until curl -sf $API/providers/acme/wagering/transactions/bet-2; do sleep 1; done
```

Enviar o mesmo `messageId` de novo não gera efeito (inbox). Um envelope malformado vai direto para a
DLQ. Os eventos publicados pela outbox saem em `wallet-events.fifo`:

```bash
docker compose exec -T localstack awslocal sqs receive-message --max-number-of-messages 10 \
  --query 'Messages[].Body' --queue-url http://localhost:4566/000000000000/wallet-events.fifo
```

O `receive-message` não apaga: as mensagens lidas ficam invisíveis por 60 s e depois voltam.

## Logs e métricas

Logs em JSON, uma linha por evento, com `correlationId`, `messageId`, `transactionId`, `walletId` e
`providerId` quando existem. Nenhum valor monetário nem header de autenticação aparece nos logs.

```bash
docker compose logs -f api sqs-consumer outbox-publisher pending-reference-worker
docker compose logs --no-log-prefix api | grep '"correlationId":"<id>"'   # ou | jq
docker compose logs nginx                                                 # log de acesso em JSON
```

Métricas Prometheus (`wws_*`: transações por status, duplicatas, retries, DLQ, conflitos e espera de
lock, outbox lag, latência e divergências de reconciliação). **O `/metrics` não é exposto pelo nginx**
(responde 404). Ele fica só na rede interna, em cada réplica (API na porta 3000, workers na 9100):

```bash
docker compose exec -T api bun -e 'console.log(await (await fetch("http://127.0.0.1:3000/metrics")).text())'
docker compose exec -T outbox-publisher bun -e 'console.log(await (await fetch("http://127.0.0.1:9100/metrics")).text())'
```

Saúde: `GET /health/live` e `GET /health/ready` (Postgres + SQS) em toda réplica e pelo nginx; os
workers respondem os mesmos caminhos na porta 9100.

## Comandos

| Comando                                         | O que faz                                                |
| ----------------------------------------------- | -------------------------------------------------------- |
| `bun run migration:up` / `migration:down`       | aplica / desfaz migrations (lê `DATABASE_*` do ambiente) |
| `bun run migration:create`                      | cria uma migration em branco (SQL escrito à mão)         |
| `bun src/entrypoints/migrate.ts pending`        | lista migrations pendentes                               |
| `docker build -t wallet-wagering-service:dev .` | imagem única de produção (API e workers)                 |
| `bun run image:migrations-check`                | `up → down → up` dentro da imagem `--production`         |
| `bun run compat:matrix`                         | mesma suíte em Bun 1.3.14 e 1.4.4, em containers         |

## Estrutura

```
src/
  domain/          entidades, value objects (Money), regras, eventos; TypeScript puro
  application/     use cases e portas (repositórios, unit of work, clock, id generator)
  infrastructure/  MikroORM e migrations, HTTP, SQS, workers, observabilidade, auth
  entrypoints/     api, sqs-consumer, outbox-publisher, pending-reference-worker, migrate
test/
  unit/  integration/  concurrency/  support/
infra/             nginx e init das filas do LocalStack
scripts/           smoke do compose, teste de carga, checagens de imagem
```
