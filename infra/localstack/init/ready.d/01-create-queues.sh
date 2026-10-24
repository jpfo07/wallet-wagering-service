#!/usr/bin/env bash
# Cria as filas do serviço no LocalStack. Roda no estágio "ready" (SQS já disponível).
# Ordem: DLQ -> fila principal com redrive para a DLQ -> fila de eventos.
set -euo pipefail

WAGER_QUEUE="${SQS_WAGER_QUEUE_NAME:-wager-transactions.fifo}"
WAGER_DLQ="${SQS_WAGER_DLQ_NAME:-wager-transactions-dlq.fifo}"
EVENTS_QUEUE="${SQS_EVENTS_QUEUE_NAME:-wallet-events.fifo}"
MAX_RECEIVE_COUNT="${SQS_MAX_RECEIVE_COUNT:-5}"
VISIBILITY_TIMEOUT="${SQS_VISIBILITY_TIMEOUT_SECONDS:-30}"

# Deduplicação sempre explícita (MessageDeduplicationId = messageId/eventId), nunca por conteúdo.
FIFO_ATTRS='"FifoQueue":"true","ContentBasedDeduplication":"false"'

awslocal sqs create-queue --queue-name "$WAGER_DLQ" \
  --attributes "{${FIFO_ATTRS},\"MessageRetentionPeriod\":\"1209600\"}" >/dev/null

DLQ_URL=$(awslocal sqs get-queue-url --queue-name "$WAGER_DLQ" --query QueueUrl --output text)
DLQ_ARN=$(awslocal sqs get-queue-attributes --queue-url "$DLQ_URL" \
  --attribute-names QueueArn --query Attributes.QueueArn --output text)

REDRIVE=$(printf '{\\"deadLetterTargetArn\\":\\"%s\\",\\"maxReceiveCount\\":\\"%s\\"}' "$DLQ_ARN" "$MAX_RECEIVE_COUNT")
awslocal sqs create-queue --queue-name "$WAGER_QUEUE" \
  --attributes "{${FIFO_ATTRS},\"VisibilityTimeout\":\"${VISIBILITY_TIMEOUT}\",\"RedrivePolicy\":\"${REDRIVE}\"}" >/dev/null

awslocal sqs create-queue --queue-name "$EVENTS_QUEUE" --attributes "{${FIFO_ATTRS}}" >/dev/null

echo "queues ready: $WAGER_QUEUE (redrive -> $WAGER_DLQ, maxReceiveCount=$MAX_RECEIVE_COUNT), $EVENTS_QUEUE"
