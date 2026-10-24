# syntax=docker/dockerfile:1
# Uma única imagem para todos os processos (api, workers, migrations); o compose escolhe o comando.
ARG BUN_IMAGE=oven/bun:1.3.14-slim@sha256:621f249399228db47cf34611ee662585e77e015250ed29d5d0932b2d3282f0b0

FROM ${BUN_IMAGE} AS deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM ${BUN_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Arquivos pertencem ao root e o processo roda como "bun": a aplicação não consegue alterar o próprio código.
COPY --from=deps /app/node_modules ./node_modules
# tsconfig.json é necessário em runtime: o Bun lê experimentalDecorators/emitDecoratorMetadata dele.
COPY package.json bunfig.toml tsconfig.json ./
COPY src ./src
USER bun
EXPOSE 3000
CMD ["bun", "run", "src/entrypoints/api.ts"]
