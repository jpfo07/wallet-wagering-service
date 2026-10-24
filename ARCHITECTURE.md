# Arquitetura — wallet-wagering-service

Documento vivo: cada fase acrescenta suas decisões, trade-offs e limitações.

## 1. Stack

| Item                  | Escolha                                    | Versão fixada                     |
| --------------------- | ------------------------------------------ | --------------------------------- |
| Runtime / pm / testes | Bun                                        | 1.3.14                            |
| Linguagem             | TypeScript estrito (typecheck via `tsc`)   | 6.0.3                             |
| Framework             | NestJS (`platform-express`)                | 12.1.3                            |
| ORM                   | MikroORM + driver PostgreSQL (`pg`)        | 7.2.5 (`@mikro-orm/nestjs` 7.1.0) |
| Banco                 | PostgreSQL                                 | 18.6                              |
| Mensageria            | SQS via LocalStack (`@aws-sdk/client-sqs`) | LocalStack 4.14.0 / SDK 3.1152.0  |
| Proxy                 | nginx (linha stable)                       | 1.30.6                            |
| Dinheiro              | decimal.js (encapsulado em `Money`)        | 10.6.0                            |

Todas as versões são exatas no `package.json` (`bunfig.toml` com `install.exact = true`), travadas no
`bun.lock` e instaladas com `--frozen-lockfile`. As imagens Docker são fixadas por tag **e** digest
`sha256`.

### Política de versões

Usamos a **estável mais recente publicada há pelo menos 7 dias** (corte da Fase 0: 17/10/2026). Uma
release com poucos dias é onde aparecem patches quebrados e pacotes comprometidos; esperar uma semana
custa quase nada em funcionalidade. Por isso: NestJS 12.1.3 (a 12.2.0 tinha 5 dias) e
typescript-eslint 8.71.2.

**TypeScript 7 fica de fora:** o `typescript-eslint` exige `typescript <6.1.0`. Mantemos o 6.0.3 até o
lint suportar o TS 7.

## 2. ORM: MikroORM (e não TypeORM)

- **Unit of Work + Identity Map explícitos:** cada requisição/mensagem tem seu próprio
  `EntityManager` (fork via `RequestContext`/`AsyncLocalStorage`), e `allowGlobalContext: false` faz
  o uso acidental do EM global falhar alto, em vez de vazar estado entre requisições.
- **`em.transactional()` + `LockMode.PESSIMISTIC_WRITE`** expressam diretamente a estratégia de
  concorrência (lock pessimista por wallet), sem SQL manual para o caso comum.
- **`defineEntity` sem decorators:** os modelos de persistência ficam separados das entidades de
  domínio (classes puras + mappers). O ORM não depende de `reflect-metadata`; só o Nest depende.
- O TypeORM tem histórico de problemas de tipagem estrita e um modelo de transação menos explícito
  (repositórios globais), o que pesa contra uma base em que a transação é a unidade de correção.

**Configuração única** (`src/infrastructure/persistence/mikro-orm.config.ts`), compartilhada pelo
módulo Nest, pelo entrypoint de migrations e pelos testes. `lock_timeout` e `statement_timeout` vão
como opções de inicialização de cada conexão do pool: um `SELECT ... FOR UPDATE` bloqueado falha
rápido em vez de segurar a requisição.

**Migrations** rodam pela API programática (`src/entrypoints/migrate.ts`: `up`/`down`/`create`/`pending`),
sem depender do loader da CLI, e num serviço próprio do compose, antes de qualquer aplicação subir.

## 3. Bun: versão e compatibilidade (spike da Fase 0)

O spike (`test/integration/spike/`) virou o smoke test permanente da infraestrutura. Ele prova contra
PostgreSQL e LocalStack reais:

| #       | O que prova                                                                                                        |
| ------- | ------------------------------------------------------------------------------------------------------------------ |
| A1      | O transpilador do Bun emite `design:paramtypes`: DI do Nest por tipo, com classes importadas de outros módulos     |
| A2      | `bun test` sobe o `ApiModule` real (`Test.createTestingModule`) e serve HTTP; `/health/ready` checa Postgres + SQS |
| A3      | O entrypoint da API sai com código 0 no `SIGTERM`, depois dos shutdown hooks do Nest                               |
| A3b     | Os entrypoints dos 3 workers respondem `/health/live` e `/health/ready` e saem com 0 no `SIGTERM`                  |
| A3c     | Os 4 entrypoints saem com 0 num `SIGTERM` recebido durante o boot (seção 6, desligamento)                          |
| B4      | `MikroOrmModule` + `RequestContext`: cada requisição recebe um `EntityManager` próprio                             |
| B5      | `numeric(20,2)` faz ida e volta como **string** exata (`"12345678901234567.89"`, `"0.10"`)                         |
| B6      | `PESSIMISTIC_WRITE` gera `SELECT ... FOR UPDATE`                                                                   |
| B7      | Uma 2ª transação realmente bloqueia no lock (verificado em `pg_stat_activity`) e lê o valor commitado              |
| B8      | `lock_timeout` falha rápido com SQLSTATE `55P03`                                                                   |
| B9      | O migrator programático descobre arquivos `.ts` e roda `up`/`down`                                                 |
| C10–C14 | SQS no LocalStack (seção 4)                                                                                        |

### Matriz 1.3.14 × 1.4.4

`bun run compat:matrix` roda o mesmo checkout em containers `oven/bun:<versão>-slim` (fixados por
digest), na rede da stack de testes:

| Bun    | `install --frozen-lockfile` | typecheck | unit | integração      | `fs.globSync({ withFileTypes })` | lockfile   |
| ------ | --------------------------- | --------- | ---- | --------------- | -------------------------------- | ---------- |
| 1.3.14 | ok                          | ok        | ok   | 20 pass, 0 fail | **não suportado**                | inalterado |
| 1.4.4  | ok                          | ok        | ok   | 20 pass, 0 fail | ok                               | inalterado |

Os tempos medidos (boot da API, duração das etapas) variaram mais entre duas rodadas da mesma versão
do que entre versões. Com essa amostra não dá para afirmar diferença de desempenho; por isso eles não
entram na decisão.

**Achado:** o MikroORM 7 tenta `import('tinyglobby')` para descobrir migrations e, se não encontrar,
cai em `fs.globSync(..., { withFileTypes: true })`, que o **Bun 1.3.14 não implementa**. No host o
problema não aparecia, porque `tinyglobby` vinha como dependência transitiva de uma devDependency (o
typescript-eslint). Na imagem de produção (`--production`) o `migrate.ts` quebrava. Correção:
`tinyglobby` passou a ser **dependência de produção explícita**. Lição registrada: verificação de
migrations roda também **dentro da imagem construída**, não só no host.

**Decisão:** continuar no **Bun 1.3.14**. Não há bloqueio, e a única diferença funcional encontrada
tem correção simples. Atualizar para a 1.4.x fica para uma decisão futura, reavaliada com a mesma
matriz.

A versão é fixada em `.bun-version`, `packageManager`/`engines` do `package.json`, na imagem do
`Dockerfile` (por digest) e em um teste unitário que compara `Bun.version` com `.bun-version`.

### Outros achados do spike que orientam as próximas fases

- **Lock timeout no PostgreSQL não vira `LockWaitTimeoutException`:** o MikroORM mapeia `40P01` →
  `DeadlockException`, mas o `55P03` chega como `DriverException` genérica com `code = '55P03'`. A
  classificação de erro transitório (Fase 3) deve olhar o **SQLSTATE**, não a classe.
- **Shutdown próprio em vez de `enableShutdownHooks()`:** o hook do Nest fecha a aplicação e
  re-emite o sinal (o processo sai "morto por sinal"). `installGracefulShutdown` chama `app.close()`
  (que executa os mesmos hooks), sai com 0 e tem prazo máximo.
- **ESLint e decorators:** com `emitDecoratorMetadata` ativo, o `consistent-type-imports` do
  typescript-eslint não transforma em `import type` as classes usadas como tipo em construtores
  decorados. O autofix não quebra a DI.

### Erros de banco transitórios (contrato para a Fase 3)

A classificação usa o **SQLSTATE** do erro (campo `code`), nunca a classe da exceção nem o texto da
mensagem. São transitórios, portanto passíveis de retry limitado com backoff, métrica e, quando o
limite se esgota, 503 com `Retry-After` na API ou devolução da visibilidade no SQS:

| SQLSTATE         | Significado                                      | Por que é transitório                                                             |
| ---------------- | ------------------------------------------------ | --------------------------------------------------------------------------------- |
| `55P03`          | `lock_not_available` (estourou o `lock_timeout`) | outra transação segura o lock da wallet; tentar de novo depois tende a passar     |
| `40P01`          | `deadlock_detected`                              | o Postgres abortou uma das transações para desfazer o ciclo; a repetição é segura |
| `40001`          | `serialization_failure`                          | conflito de concorrência; a transação inteira pode ser repetida                   |
| `08xxx` (classe) | exceção de conexão (`08000`, `08003`, `08006`…)  | conexão perdida ou recusada; o banco pode voltar                                  |
| `57P01`          | `admin_shutdown`                                 | o servidor encerrou a sessão (restart/failover); uma nova conexão resolve         |

Por que a repetição é segura: toda a operação financeira roda em **uma** transação SQL. Esses erros
acontecem antes do commit ou o abortam, então nada foi persistido. A repetição refaz tudo desde o lock
da wallet, e a idempotência persistente protege contra efeito duplicado. Qualquer outro SQLSTATE
(violação de constraint, erro de sintaxe, etc.) não é transitório.

## 4. SQS: LocalStack 4.14.0

**Por que essa versão:** em março de 2026 a LocalStack descontinuou a edição community. O repositório
foi arquivado e as imagens novas (`2026.x`) exigem `LOCALSTACK_AUTH_TOKEN` (conta no plano Hobby). A
4.14.0 é a última imagem community (Apache 2.0) e sobe sem conta, o que importa para quem avalia o
projeto e para o CI.

**Risco:** a imagem não recebe mais atualizações (nem de segurança). Mitigações:

- tag e digest fixados (`localstack/localstack:4.14.0@sha256:75ba7a4b…03f2`);
- o comportamento de que dependemos é coberto por testes (C10–C14), então uma troca de emulador é
  validada pela mesma suíte;
- endpoint sempre por variável de ambiente (`SQS_ENDPOINT`), e URLs de fila sempre obtidas por
  `GetQueueUrl`, nunca montadas à mão.

**Plano B:** MiniStack, que o enunciado aceita, ou a AWS real. A troca é só de env (`SQS_ENDPOINT`
vazio = AWS).

**URLs de fila sem `localhost.localstack.cloud`:** a LocalStack vem desativando esse DNS. No 4.14.0:

- `SQS_ENDPOINT_STRATEGY=path` gera `http://<host>/queue/<região>/<conta>/<fila>`, e não o formato
  esperado;
- `SQS_ENDPOINT_STRATEGY=off` gera `http://<host>/<conta>/<fila>`;
- em ambos os casos o `<host>` vem de `LOCALSTACK_HOST`, não da requisição.

Configuração adotada: `SQS_ENDPOINT_STRATEGY=off` + `LOCALSTACK_HOST=localstack:4566`, o que resulta
em `http://localstack:4566/000000000000/<fila>`, resolvível na rede do compose. Fora da rede, por
exemplo nos testes rodando no host, o nome `localstack` não resolve, mas isso não importa: o SDK envia
toda requisição para o `endpoint` configurado (teste C10b).

**O SDK nunca segue o host da `QueueUrl`:** no `@aws-sdk/client-sqs`, a opção `useQueueUrlAsEndpoint`
vale `true` por padrão. Nesse modo, quando o cliente não tem `endpoint` explícito, o middleware
`queueUrlMiddleware` troca o destino da requisição pelo host contido na `QueueUrl`. Hoje sempre há
endpoint explícito, mas não queremos depender dessa regra implícita. Por isso `createSqsClient` fixa
`useQueueUrlAsEndpoint: false`: toda requisição vai para `SQS_ENDPOINT` (ou para o endpoint regional
da AWS, quando ele é vazio), independentemente do host que o emulador escreve nas URLs. Isso é coberto
por teste unitário (configuração resolvida) e de integração (C10b).

**Comportamento validado (C10–C14):** URL no formato acima; filas FIFO com
`ContentBasedDeduplication=false` (dedup sempre explícito); redrive para a DLQ com `maxReceiveCount`;
`MessageDeduplicationId` descartando duplicata dentro da janela (o envio duplicado devolve o
`MessageId` original); `ChangeMessageVisibility` escondendo e liberando a mensagem
(`ApproximateReceiveCount` incrementa); mensagem indo para a DLQ ao exceder `maxReceiveCount`.

**Filas** (criadas por `infra/localstack/init/ready.d/01-create-queues.sh`):
`wager-transactions-dlq.fifo` → `wager-transactions.fifo` (redrive, `maxReceiveCount` por env, padrão
5, `VisibilityTimeout` 30 s) → `wallet-events.fifo`. O healthcheck do LocalStack só fica verde quando
o script de init terminou, ou seja, as filas já existem.

## 5. Ambiente de testes

- **Stack própria:** `docker-compose.test.yml` (projeto `wws-test`, portas 55432/54566), separada da
  de desenvolvimento. Postgres em `tmpfs` com `fsync=off`: dados descartáveis, testes rápidos.
- **PostgreSQL 18:** o `VOLUME` da imagem oficial passou a ser `/var/lib/postgresql` (com `PGDATA` em
  `/var/lib/postgresql/18/docker`). Volumes e `tmpfs` são montados nesse caminho; montar no antigo
  `/var/lib/postgresql/data` criaria um volume anônimo e perderia dados.
- **Um banco por suíte, clonado de um template migrado:** `CREATE DATABASE … TEMPLATE` leva
  milissegundos. O nome do template é derivado do hash dos arquivos de migration, então mudar o schema
  gera um template novo em vez de reaproveitar um velho.
- **Sem `TRUNCATE` entre testes:** o ledger vai bloquear UPDATE/DELETE/TRUNCATE por trigger. Limpar
  com TRUNCATE exigiria desligar a proteção que queremos provar. Dentro da suíte, cada teste cria os
  próprios dados (IDs novos), então não há limpeza nem dependência de ordem.
- **Corrida no template:** criar/migrar o template e todo `CREATE DATABASE … TEMPLATE` acontecem sob
  o mesmo advisory lock, o que é seguro com `bun test --parallel` (processos separados). A conexão
  usada para migrar o template é fechada (`orm.close(true)`) antes de qualquer clone. Se ainda assim
  houver alguém conectado, o erro `55006` vira um `TemplateInUseError` que diz qual template, quais
  sessões estão conectadas e a causa provável.
- **Filas por suíte:** cada suíte cria a própria topologia (DLQ, principal com redrive, eventos) com
  prefixo único e a apaga no fim. `PurgeQueue` é evitado (janela de 60 s na AWS).
- **Sem `sleep` para esperar dar certo:** `waitFor()` faz polling com timeout.

## 6. Orquestração local e multi-instância

`docker-compose.yml` sobe a solução no formato em que ela precisa estar correta: **várias
instâncias de cada processo ao mesmo tempo**. Uma única imagem serve todos os processos; o serviço
escolhe o comando.

```
postgres (healthy) ──► migrations (exit 0) ──┐
localstack (healthy = init concluído) ───────┼──► api ×3 (healthy) ──► nginx :8080
                                             └──► sqs-consumer ×2 · outbox-publisher ×2 · pending-reference-worker ×2
```

- **Ordem de subida pelos healthchecks, não pela ordem de declaração:** `depends_on` com
  `service_healthy` e `service_completed_successfully`. O LocalStack só fica saudável quando o script
  de init terminou, ou seja, as filas existem antes de qualquer consumidor subir.
- **Migrations num serviço próprio, que roda uma vez:** as réplicas da API nunca disputam a execução de
  migrations no boot, e se a migration falhar nenhuma aplicação sobe.
- **Uma única porta da API (8080, no nginx).** Postgres e LocalStack ficam expostos só em `127.0.0.1`,
  para ferramentas locais.
- **nginx na frente das 3 APIs:**
  - `resolver 127.0.0.11 valid=5s` + `server api:3000 resolve` (nginx ≥ 1.27.3): o nome `api` resolve
    para os IPs de todas as réplicas e é reavaliado continuamente; uma réplica que reinicia com outro
    IP volta ao pool sozinha.
  - `proxy_next_upstream error timeout http_502 http_503`: se uma réplica não responde, a requisição é
    refeita em outra, **só para métodos idempotentes**. O nginx nunca reenvia POST. Quem reenvia uma
    transação é o provedor, e a idempotência persistente protege esse caso.
  - Cada resposta traz `X-Instance-Id` (definido pela API) e `X-Upstream-Addr` (definido pelo nginx),
    o que deixa visível qual réplica atendeu.
- **Workers** (placeholders até as Fases 5 e 6): sobem o contexto Nest (DI, ORM, cliente SQS) e um
  servidor HTTP interno (`WORKER_HEALTH_PORT`, 9100) com `/health/live` e `/health/ready`. No SIGTERM
  saem com 0 depois de fechar o pool e o cliente SQS. A readiness da API e a dos workers usam a mesma
  função (`checkReadiness`).
- **Desligamento (SIGTERM):** o Docker manda SIGTERM e, se o processo não sair dentro do
  `stop_grace_period` (15 s), manda SIGKILL. O handler de SIGTERM é instalado **antes do boot**: os
  entrypoints importam estaticamente só a config e `graceful-shutdown.ts`, e carregam Nest, ORM e SDK
  com `await import()` depois. Antes, o handler só existia no fim do boot. O processo é PID 1 no
  container, e o kernel ignora sinais que o PID 1 não trata, então um SIGTERM durante o boot se
  perdia: o container ficava pendurado até o SIGKILL (reproduzido: 18 s e exit 137). Agora um SIGTERM
  antes de o app estar montado sai com 0 na hora (ainda não há trabalho em andamento); depois, o
  fechamento normal roda (para de aceitar trabalho, fecha pool e cliente SQS) e sai com 0. Como rede de
  segurança, o compose usa `init: true`: o tini vira PID 1 e repassa sinais, cobrindo os poucos
  milissegundos de startup do runtime antes do handler existir.

  | Exit           | Significado                                                                                                                                                                               | Avaliação                                                                                                                                                                                                                                                |
  | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | 0              | o handler recebeu o SIGTERM, fechou os recursos e saiu                                                                                                                                    | esperado                                                                                                                                                                                                                                                 |
  | 143 (128 + 15) | morreu pelo próprio SIGTERM, antes de o handler existir; com o tini isso só acontece nos primeiros milissegundos de startup, quando ainda não há conexão aberta nem trabalho em andamento | aceitável: parada imediata e sem perda                                                                                                                                                                                                                   |
  | 137 (128 + 9)  | ignorou ou não terminou a tempo e levou SIGKILL no fim do grace period                                                                                                                    | **falha**: o desligamento travou, o deploy/scale-down esperou o grace period inteiro, e no futuro uma mensagem ou lote poderia ser cortado no meio (a recuperação ficaria por conta do visibility timeout e da idempotência, mas não é o caminho normal) |

  Só o 137 é falha porque é o único que significa "o processo não respeitou o sinal". 0 e 143 são
  paradas imediatas; a diferença é só se o handler já estava instalado.

- **Healthcheck sem curl:** a imagem slim não tem curl; `src/entrypoints/healthcheck.ts` faz o
  `fetch` local.
- **Conexões:** 9 processos × pool de 10 = 90 conexões; o Postgres de dev tem `max_connections=200`.

**Prova automatizada** (`scripts/compose-smoke.sh`, também no CI):

1. todos os serviços `healthy`, na quantidade esperada de réplicas, e migrations com exit 0;
2. 30 requisições pelo nginx atendidas por 3 instâncias distintas (na execução local: 10/10/10);
3. failover: com uma réplica parada, 20/20 requisições têm sucesso pelas outras duas. A primeira
   requisição que cai na réplica morta espera o `proxy_connect_timeout` (2 s) e é refeita em outra
   réplica, sem erro para o cliente; depois o DNS re-resolvido tira a réplica do pool;
4. a réplica volta a `healthy` e o nginx volta a balancear entre 3;
5. um `sqs-consumer` recebe `docker stop` logo depois de reiniciar (boot em andamento) e precisa sair
   com 0 ou 143 em menos de 5 s (nunca 137);
6. `docker compose stop` com a stack saudável: os 13 containers saem com exit 0, e cada container da
   aplicação (API, workers, nginx) para em menos de 8 s contados do início do `stop`. O LocalStack
   tem `stop_grace_period: 30s`: costuma parar em 2–3 s, mas com a stack inteira no ar já passou dos
   10 s padrão e levou SIGKILL. Um travamento real dele continua falhando o smoke (137).

**Migrations dentro da imagem** (`scripts/image-migrations-check.sh`, também no CI): roda
`up → down → up` com as migrations do repositório e uma migration de sonda montada na pasta, na
imagem instalada com `--production`. Isso pega dependência que só existe no host (seção 3).

## 7. CI (GitHub Actions)

Dois jobs. Nenhum deles mocka PostgreSQL ou SQS.

- **checks:** Bun pela `.bun-version`, `bun install --frozen-lockfile`, prettier, lint, typecheck,
  testes unitários e, com a stack de testes no ar, os testes de integração.
- **image-and-compose:** build da imagem de produção, migrations dentro da imagem e o smoke
  multi-instância completo da stack de dev.

As actions são fixadas por SHA de commit (a tag fica no comentário), pelo mesmo motivo das imagens
fixadas por digest: uma tag pode ser movida, um SHA não.

## 8. Domínio

`src/domain` é TypeScript puro: não importa Nest, MikroORM, nem nada de `application`/`infrastructure`.
As únicas dependências externas são `decimal.js` (só em `money.ts`) e `node:crypto` (só em
`payload-hash.ts`). Um teste de arquitetura (`test/unit/architecture/domain-boundaries.spec.ts`) varre
os arquivos e falha se aparecer outro import, ou se o domínio ler o relógio (`Date.now`, `new Date()`
sem argumento), gerar aleatoriedade ou ID (`Math.random`, `randomUUID`) ou converter texto em float
(`parseFloat`, `Number()`). Hora, IDs e `random` chegam como **valores** de quem chama; as portas
`Clock` e `IdGenerator` ficam na camada de aplicação. Assim o domínio é determinístico por construção.

**Princípio: regra de negócio violada é um resultado; invariante violada é uma exceção.** "BET sem
saldo" é um caminho normal: a transação vira REJECTED com `failureCode`. "Alguém chamou `debit` sem
checar o saldo" é bug, e o domínio lança um erro tipado (`InvariantViolationError` e subclasses).
Entrada malformada lança `ValidationError` (vira 400). Todo erro tem um `code` estável.

### Money

- Contrato de entrada estrito: `^(0|[1-9]\d{0,17})\.\d{2}$` e moeda `^[A-Z]{3}$` (formato ISO-4217,
  não a lista oficial). Isso significa exatamente 2 casas, sem sinal, sem zero à esquerda e no máximo
  18 dígitos inteiros, o que cabe em `numeric(20,2)`. Rejeita `NaN`, `Infinity`, `1e3`, `""`, `"25"`,
  `"25.5"`, `"25.000"`, `"-1.00"`, `"01.00"`.
- Zero à esquerda é proibido para que cada valor tenha **uma única grafia**: `"01.00"` e `"1.00"`
  gerariam hashes de payload diferentes para o mesmo valor.
- `Decimal` privado, criado por `Decimal.clone({ precision: 40 })` (não altera a configuração global).
  Como toda entrada tem 2 casas e só existem soma e subtração, **nunca há arredondamento**.
  Serialização por `toFixed(2)` (sem notação científica), com `-0.00` normalizado para `0.00`.
- Instâncias congeladas; toda operação devolve uma nova. Operar entre moedas diferentes lança erro;
  `equals` entre moedas diferentes apenas devolve `false`.
- Passar do teto de `numeric(20,2)` lança `MoneyOverflowError` (invariante, não regra de negócio).

### Wallet e ledger: saldo e lançamento nascem juntos

1. O saldo é privado e não tem setter. Só `open`, `debit` e `credit` o alteram.
2. **Valida tudo, depois muda.** `debit`/`credit` calculam o saldo antes e depois e criam o
   `WalletLedgerEntry` (cuja factory confere `before ± amount = after`, valor > 0, moeda única e
   saldos ≥ 0). Só então trocam saldo, `version` e `updatedAt`. Se algo lança erro, a wallet fica
   exatamente como estava.
3. O lançamento é devolvido **e** guardado na wallet (`pullNewLedgerEntries()`). O repositório
   persiste a wallet e esses lançamentos na mesma transação SQL, então ninguém "esquece" o retorno.
4. Uma movimentação por transação por wallet (o `UNIQUE(transaction_id, wallet_id)` é o backstop).
5. `version = 1` após a criação, inclusive com o crédito de abertura (ele faz parte da criação), e
   incrementa a cada mudança de saldo depois disso.

`WalletLedgerEntry` é imutável por estrutura: campos `readonly`, instância congelada e nenhum método
além de `isBalanced()`.

### WagerTransaction: transições

| De                          | Para                            | Método                               |
| --------------------------- | ------------------------------- | ------------------------------------ |
| PENDING                     | PROCESSED                       | `markProcessed`                      |
| PENDING                     | REJECTED                        | `reject`                             |
| PENDING                     | PENDING_REFERENCE               | `markPendingReference`               |
| PENDING                     | FAILED                          | `fail`                               |
| PENDING_REFERENCE           | PENDING_REFERENCE (só reagenda) | `scheduleNextReferenceCheck`         |
| PENDING_REFERENCE           | PROCESSED / REJECTED / FAILED   | `markProcessed` / `reject` / `fail`  |
| PROCESSED, REJECTED, FAILED | qualquer outra coisa            | lança `InvalidTransactionStateError` |

Na prática, PENDING só existe em memória: a transação é criada e decidida na mesma transação SQL.

Adaptações de assinatura em relação ao esqueleto do enunciado (permitidas por ele):
`markProcessed`, `reject` e `markPendingReference` recebem o **saldo observado**, que fica gravado na
transação para que o replay devolva exatamente a resposta original. `markPendingReference` também
recebe o agendamento (próxima checagem e expiração). `OutboxMessage.scheduleRetry` recebe a política
de backoff e a função `random`.

`create` valida o que não depende de estado guardado: OPENING proibido, provider `internal`
reservado, referência obrigatória para REFUND/ROLLBACK, BET sem referência, autorreferência, valor > 0
(LOSS aceita 0) e campos obrigatórios. A OPENING é criada só por `WagerTransaction.opening`, já
PROCESSED, com identificadores reservados: `providerId = "internal"`,
`externalTransactionId = "opening:{walletId}"`, `idempotencyKey = "internal:opening:{walletId}"` e
`roundId`/`gameId = "opening"`.

`ledgerDirectionFor`: BET → DEBIT; WIN, REFUND e OPENING → CREDIT; ROLLBACK → o inverso do que a
referência fez (ROLLBACK de BET credita; de WIN ou REFUND, debita). LOSS não tem direção.

### Estado da referência (`ReferenceState`)

O que já aconteceu com uma transação referenciada. A camada de aplicação só **carrega linhas** (a
referência, as transações PROCESSED que apontam para ela e os ROLLBACKs PROCESSED dessas); o
**cálculo** é do domínio. Uma transação está "desfeita" quando existe um ROLLBACK PROCESSED que a
referencia.

| Campo                 | Regra                                                                         | Usado por                  |
| --------------------- | ----------------------------------------------------------------------------- | -------------------------- |
| `everReversed`        | existe REFUND/ROLLBACK PROCESSED da referência, **mesmo que depois desfeito** | novas reversões            |
| `effectivelyReversed` | existe REFUND/ROLLBACK PROCESSED da referência que **não** foi desfeito       | WIN e LOSS                 |
| `hasActiveWin`        | existe WIN PROCESSED da BET que não foi desfeito                              | REFUND/ROLLBACK de uma BET |

- Bastam dois níveis, sem recursão: ROLLBACK nunca referencia ROLLBACK, então as únicas cadeias
  possíveis são BET ← REFUND ← ROLLBACK e BET ← WIN ← ROLLBACK.
- `everReversed` é coerente com o índice único do schema (no máximo uma reversão PROCESSED por
  referência): um REFUND desfeito continua PROCESSED, então o banco também barra uma segunda reversão.
- LOSS dependente é ignorado: ele nunca moveu saldo.
- Entrada incoerente (dependente de outra referência, não PROCESSED, rollback de quem não é
  dependente) lança `InvalidReferenceStateError`: é bug de quem carregou.

### Regras da seção 7: `settleWager`

Um único serviço de domínio aplica as regras. Ele é chamado pelo use case (na primeira vez) e pelo
worker de PENDING_REFERENCE (no reprocessamento), sempre com a wallet carregada sob o lock dela, e
altera transação e wallet em memória. Como toda transação de uma wallet só muda sob o lock dessa
wallet, a referência e o estado dela, lidos sob o mesmo lock, ficam estáveis até o commit.

**Ordem fixa das checagens** (a primeira que falha vence, então a mesma situação sempre recebe o
mesmo código):

| #   | Regra                                                                    | Resultado                                                                            |
| --- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| 1   | player da transação = player da wallet                                   | `WALLET_PLAYER_MISMATCH`                                                             |
| 2   | moeda da transação = moeda da wallet                                     | `CURRENCY_MISMATCH`                                                                  |
| 3   | referência encontrada por `(providerId, referenceExternalTransactionId)` | ausente → PENDING_REFERENCE; expirada → `REFERENCE_NOT_FOUND`                        |
| 4   | mesma provider, player, wallet, moeda e rodada                           | `REFERENCE_MISMATCH`                                                                 |
| 5   | REFUND → BET; ROLLBACK → BET, WIN ou REFUND; WIN/LOSS → BET              | `REFERENCE_KIND_NOT_ALLOWED`                                                         |
| 6   | referência PENDING/PENDING_REFERENCE → espera; REJECTED/FAILED → recusa  | PENDING_REFERENCE (expirada → `REFERENCE_NOT_PROCESSED`) / `REFERENCE_NOT_PROCESSED` |
| 7a  | REFUND/ROLLBACK: `everReversed`                                          | `REFERENCE_ALREADY_REVERSED`                                                         |
| 7b  | REFUND/ROLLBACK de BET: `hasActiveWin`                                   | `REFERENCE_HAS_ACTIVE_SETTLEMENT`                                                    |
| 7c  | WIN/LOSS: `effectivelyReversed`                                          | `REFERENCE_ALREADY_REVERSED`                                                         |
| 8   | valor da reversão = valor da referência (sem reversão parcial)           | `AMOUNT_MISMATCH`                                                                    |
| 9   | LOSS                                                                     | PROCESSED sem lançamento e sem `version++`                                           |
| 10  | débito sem saldo: BET / ROLLBACK de WIN ou REFUND                        | `INSUFFICIENT_FUNDS` / `REVERSAL_WOULD_OVERDRAW`                                     |
| 11  | aplica `debit`/`credit` e `markProcessed` com o saldo observado          | PROCESSED                                                                            |

Uma rejeição sai antes do passo 11 e nunca toca a wallet. A referência ainda ausente reagenda a
próxima checagem com backoff exponencial (`ExponentialBackoff`, _equal jitter_: metade fixa, metade
aleatória). Ao expirar, vira `REFERENCE_NOT_FOUND`; se a referência existe mas continua pendente na
expiração, vira `REFERENCE_NOT_PROCESSED`, porque ela foi encontrada.

### Interpretações das regras de negócio

- **Uma reversão por referência, no total:** REFUND **ou** ROLLBACK, nunca os dois. O enunciado
  proíbe reverter duas vezes "pelo mesmo tipo de operação"; ir além impede crédito duplicado.
- **ROLLBACK** referencia BET, WIN ou REFUND, nunca outro ROLLBACK. ROLLBACK de WIN e de REFUND
  debita; se o débito deixaria saldo negativo → `REVERSAL_WOULD_OVERDRAW` (código distinto de
  `INSUFFICIENT_FUNDS`, porque operacionalmente é outra situação).
- **WIN e LOSS** aceitam referência opcional (sempre a uma BET), com as mesmas validações de
  contexto. BET com referência é payload inválido.
- **WIN/LOSS sobre BET revertida** é rejeitado (`REFERENCE_ALREADY_REVERSED`) só se a BET estiver
  efetivamente revertida: pagar prêmio de aposta cancelada é crédito indevido. Se o REFUND foi
  desfeito por ROLLBACK, a BET volta ao jogo e o WIN é aceito.
- **REFUND/ROLLBACK de BET com WIN ativo** é rejeitado (`REFERENCE_HAS_ACTIVE_SETTLEMENT`). Permitir
  criaria crédito indevido (BET 10, WIN 50, ROLLBACK da BET +10: o jogador fica com o prêmio de uma
  aposta cancelada). O provedor desfaz primeiro o WIN e depois reverte a BET. REFUND depois de LOSS é
  permitido, porque LOSS não move saldo.
- **Vários WIN para a mesma BET** são permitidos (jogos com vários prêmios por rodada). Não há teto
  nem checagem da soma dos prêmios: o valor do WIN é semântica do provedor.
- **Valores:** BET, WIN, REFUND e ROLLBACK exigem valor > 0; LOSS aceita ≥ 0.

### Taxonomia de códigos

Ações para o provedor: **RETRY** (reenviar a mesma requisição, com a mesma chave, mais tarde: é
seguro), **FIX** (enviar uma nova requisição corrigida, com nova chave e novo `externalTransactionId`)
e **GIVE_UP** (o resultado é final; reenviar só devolve o replay). O catálogo vive em
`src/domain/shared/failure-code.ts` como dado tipado (código → categoria → ação). A camada HTTP mapeia
por **categoria**, nunca por código solto.

Rejeições persistidas (`FailureCode`, status REJECTED ou FAILED):

| Código                            | Quando                                                     | Ação                                            |
| --------------------------------- | ---------------------------------------------------------- | ----------------------------------------------- |
| `INSUFFICIENT_FUNDS`              | BET sem saldo                                              | GIVE_UP                                         |
| `REVERSAL_WOULD_OVERDRAW`         | ROLLBACK de WIN/REFUND deixaria o saldo negativo           | GIVE_UP (tratamento manual)                     |
| `REFERENCE_NOT_FOUND`             | a referência não chegou dentro do TTL                      | FIX (enviar a referência, reenviar com novo id) |
| `REFERENCE_ALREADY_REVERSED`      | referência já revertida                                    | GIVE_UP                                         |
| `REFERENCE_HAS_ACTIVE_SETTLEMENT` | REFUND/ROLLBACK de BET com WIN ativo                       | FIX (ROLLBACK do WIN antes)                     |
| `REFERENCE_KIND_NOT_ALLOWED`      | tipo de referência proibido                                | FIX                                             |
| `REFERENCE_MISMATCH`              | provider, player, wallet, moeda ou rodada diferentes       | FIX                                             |
| `REFERENCE_NOT_PROCESSED`         | referência REJECTED/FAILED, ou ainda pendente na expiração | GIVE_UP                                         |
| `AMOUNT_MISMATCH`                 | valor da reversão ≠ valor da referência                    | FIX                                             |
| `CURRENCY_MISMATCH`               | moeda ≠ moeda da wallet                                    | FIX                                             |
| `WALLET_PLAYER_MISMATCH`          | wallet de outro player                                     | FIX                                             |
| `INTERNAL_PERMANENT_ERROR`        | FAILED: estado irrecuperável                               | GIVE_UP (acionar operação)                      |

Códigos que não viram transação persistida (`ErrorCode`):

| Código                                                                                                                                                            | Categoria       | Ação    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------- |
| `INVALID_PAYLOAD`, `INVALID_AMOUNT`, `INVALID_CURRENCY`, `KIND_NOT_ALLOWED`, `PROVIDER_RESERVED`, `REFERENCE_REQUIRED`, `REFERENCE_NOT_ALLOWED`, `SELF_REFERENCE` | INVALID_PAYLOAD | FIX     |
| `WALLET_NOT_FOUND`                                                                                                                                                | NOT_FOUND       | FIX     |
| `IDEMPOTENCY_KEY_REUSED`, `EXTERNAL_TRANSACTION_ID_CONFLICT`                                                                                                      | CONFLICT        | FIX     |
| `WALLET_ALREADY_EXISTS`                                                                                                                                           | CONFLICT        | GIVE_UP |
| `TRANSIENT_FAILURE`                                                                                                                                               | TRANSIENT       | RETRY   |

PENDING_REFERENCE não é falha: o provedor pode consultar a transação ou reenviar a mesma requisição.

### Idempotência e payloadHash

- **Entram no hash** (campos de negócio): `providerId`, `externalTransactionId`, `playerId`,
  `walletId`, `roundId`, `gameId`, `kind`, `money` (`{amount, currency}` normalizado por `Money`) e
  `referenceExternalTransactionId` (só quando presente).
- **Não entram:** o header `Idempotency-Key` e o `idempotencyKey` da mensagem SQS (a chave é o índice,
  não o conteúdo), `messageId`, `type`, `occurredAt`, `correlationId` e qualquer metadado de
  transporte. Os campos são escolhidos um a um, então propriedades extras nunca vazam para o hash.
  Consequência: a mesma operação enviada por HTTP e por SQS gera o mesmo hash.
- **JSON canônico:** chaves ordenadas recursivamente (ordem de code unit UTF-16, a ordenação padrão do
  JavaScript), sem espaços, strings escapadas por `JSON.stringify`, propriedades `undefined` omitidas.
  Aceita só objetos simples, arrays, strings e booleanos. **Números e `null` são recusados:** dinheiro
  é sempre string, e números têm grafias ambíguas (`1` × `1.0`).
- `payloadHash = SHA-256(JSON canônico)` em hex minúsculo. Um teste "golden" fixa o valor de um
  payload conhecido, calculado fora do código: mudar o algoritmo sem querer transformaria todo replay
  em conflito.
- `checkIdempotency`: mesma chave e mesmo hash → REPLAY; mesma chave e hash diferente →
  `IDEMPOTENCY_KEY_REUSED`; chave nova para um `(providerId, externalTransactionId)` existente →
  `EXTERNAL_TRANSACTION_ID_CONFLICT`, mesmo com payload idêntico (uma operação do provedor não pode
  viver sob duas chaves).

### Eventos, inbox e outbox

- `IntegrationEvent<T>` abstrato; `eventType` e `version` são literais em cada subclasse.
  `WagerTransactionProcessed` (inclusive LOSS), `WagerTransactionRejected`, `WalletBalanceChanged`,
  `WagerTransactionPendingReference` e, além do mínimo, `WagerTransactionFailed` (sem ele, quem
  aguarda uma PENDING_REFERENCE que acabou em FAILED nunca seria avisado).
- `data` só tem valores JSON (dinheiro como `MoneyProps`, datas ISO-8601) e é congelado em
  profundidade. `causationId` é omitido quando ausente.
- `aggregateId = walletId` em todos os eventos: vira o `MessageGroupId`, então o consumidor recebe os
  eventos de uma wallet na ordem.
- `OutboxMessage.enqueue(event)`: `id = eventId` (também é o `MessageDeduplicationId`), publicável na
  hora. `scheduleRetry` usa backoff exponencial com teto e **não tem limite de tentativas**: desistir
  seria perder um evento confirmado. O alerta vem da métrica de outbox lag.
- `InboxMessage`: `markProcessed` uma única vez; `matchesPayload` distingue duplicata (mesmo hash) de
  mensagem envenenada (mesmo `messageId`, payload diferente).

### Limitações conhecidas

- **Prêmio duplicado com ids diferentes:** um provedor com bug que reenvia o mesmo WIN com outro
  `externalTransactionId` gera dois créditos legítimos do ponto de vista do serviço. A idempotência
  protege contra reenvio do mesmo id, não contra ids diferentes.
- **`hasActiveWin` e `effectivelyReversed` não têm backstop no schema** (só `everReversed` tem, pelo
  índice único). A garantia é o lock da wallet. WIN e REFUND da mesma BET chegando juntos são
  serializados por ele, e os dois desfechos são coerentes: WIN primeiro → REFUND recusado
  (`REFERENCE_HAS_ACTIVE_SETTLEMENT`); REFUND primeiro → WIN recusado (`REFERENCE_ALREADY_REVERSED`).
- **Detecção de movimento duplicado na wallet** vale para a instância em memória. Entre processos, o
  backstop é o `UNIQUE(transaction_id, wallet_id)` do ledger.
