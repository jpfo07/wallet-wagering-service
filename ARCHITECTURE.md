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
- **Healthcheck sem curl:** a imagem slim não tem curl; `src/entrypoints/healthcheck.ts` faz o
  `fetch` local.
- **Conexões:** 9 processos × pool de 10 = 90 conexões; o Postgres de dev tem `max_connections=200`.

**Prova automatizada** (`scripts/compose-smoke.sh`, também no CI):

1. todos os serviços `healthy`, na quantidade esperada de réplicas, e migrations com exit 0;
2. 30 requisições pelo nginx atendidas por 3 instâncias distintas (na execução local: 10/10/10);
3. failover: com uma réplica parada, 20/20 requisições têm sucesso pelas outras duas. A primeira
   requisição que cai na réplica morta espera o `proxy_connect_timeout` (2 s) e é refeita em outra
   réplica, sem erro para o cliente; depois o DNS re-resolvido tira a réplica do pool;
4. a réplica volta a `healthy` e o nginx volta a balancear entre 3.

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
