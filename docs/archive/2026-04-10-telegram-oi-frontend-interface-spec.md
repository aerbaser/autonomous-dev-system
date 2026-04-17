# Telegram OI Monitor Frontend Interface Spec

## Purpose

This document defines the frontend-facing contract for the future web UI of the Telegram-based open-interest monitoring product. It is intentionally ahead of implementation so the UI can be designed without waiting for the full backend to settle.

Primary UI capabilities:

- dashboard views with OI + price correlation
- alert rule management
- Telegram chat subscription visibility
- exchange and symbol filtering
- health and freshness visibility
- operator actions for mute/resume/replay/reconfigure

## Callers

- React dashboard for operators and traders
- Telegram bot admin workflows that may reuse the same backend resources
- future automation clients (CLI, webhook bridge, external strategy engine)

## Constraints

- must support one coin, a list of exchanges, or all exchanges
- must support historical reads and near-real-time updates
- must expose health/freshness as first-class data, not just logs
- should keep frontend implementation simple for MVP
- should not leak exchange-specific normalization complexity to the UI

## Current r4-Validated MVP Contract

The live `r4` E2E run validates a narrower frontend contract than the full future-facing design below.

Current stable surface for UI work:

- `GET /api/oi-data`
- `GET /api/signals`
- `GET /api/symbols`
- `GET /api/exchanges`
- `GET /health`
- `GET /metrics`
- Telegram command flow for mutations: `/start`, `/help`, `/subscribe`, `/unsubscribe`, `/status`, `/health`

Current UI assumptions:

- dashboard is polling-first, not stream-first
- chart payload is time-series oriented: `time`, `openInterest`, `price`
- canonical symbol format should stay exchange-agnostic, for example `BTC/USDT:USDT`
- threshold and cooldown changes are config-driven for MVP, not frontend writes
- route files in generated code are not the source of truth yet; the source of truth is the architecture/spec artifacts from the run

Everything else in this document that describes rules CRUD, subscription mutation, operator command bus, or SSE/live feeds should be treated as future/admin surface until a later run generates and verifies those endpoints.

## Design A: Minimal Workspace API

### Interface signature

- `GET /api/workspace?symbol=BTC&range=7d`
- `POST /api/actions`
- `GET /api/stream?symbol=BTC`

### Usage example

- dashboard boot:
  - `GET /api/workspace?symbol=BTC&range=7d`
  - response includes chart series, signal markers, active rules, subscriptions, and health summary
- operator action:
  - `POST /api/actions`
  - body: `{ "type": "rule.pause", "ruleId": "rule_btc_spike" }`

### What this hides

- resource joins across alerts, subscriptions, health, and time-series
- exchange normalization and aggregation logic
- read-model shaping for each screen

### Trade-offs

- very fast for MVP UI
- thin client and few round-trips
- weak composability for third-party clients
- action bus can become opaque if overused

## Design B: Flexible Resource Graph

### Interface signature

- `GET /api/symbols`
- `GET /api/dashboard/series`
- `GET /api/signals`
- `GET /api/rules`
- `POST /api/rules`
- `PATCH /api/rules/:id`
- `GET /api/subscriptions`
- `POST /api/subscriptions`
- `GET /api/health`
- `GET /api/stream`

### Usage example

- symbol picker:
  - `GET /api/symbols?scope=tracked`
- chart:
  - `GET /api/dashboard/series?symbol=BTC&exchanges=binance,bybit&range=7d&metrics=price,oi`
- rules page:
  - `GET /api/rules?symbol=BTC`
  - `PATCH /api/rules/rule_btc_divergence`

### What this hides

- canonical symbol mapping
- bucket alignment across exchanges
- detector internals and cooldown evaluation

### Trade-offs

- best long-term extensibility
- good fit for automation and alternate clients
- more endpoints and more frontend data stitching
- more backend contract surface to stabilize

## Design C: Workflow-Optimized Operator BFF

### Interface signature

- `GET /api/dashboard/:symbol`
- `GET /api/operator/inbox`
- `POST /api/operator/commands`
- `GET /api/operator/status`
- `GET /api/live`

### Usage example

- open BTC page:
  - `GET /api/dashboard/BTC?range=7d&exchangeScope=all`
- replay missed alerts:
  - `GET /api/operator/inbox?symbol=BTC&limit=20`
- mute noisy rule:
  - `POST /api/operator/commands`
  - body: `{ "command": "mute_rule", "ruleId": "rule_btc_spike", "minutes": 60 }`

### What this hides

- all resource orchestration and validation
- most UI orchestration logic
- health aggregation and last-mile operator affordances

### Trade-offs

- best for fast UI implementation
- weakest generic API story
- risks backend endpoints becoming screen-specific

## Recommended Approach

Use a hybrid of Design B and Design C:

- resource-oriented reads for data that will be reused
- one operator action endpoint for mutable command-style actions
- one live stream endpoint for near-real-time updates

For the next frontend phase, implement against the `Current r4-Validated MVP Contract` first. Treat the hybrid surface below as the target expansion path, not the current guaranteed contract.

Recommended stable surface:

- `GET /api/symbols`
- `GET /api/dashboard/series`
- `GET /api/signals`
- `GET /api/rules`
- `POST /api/rules`
- `PATCH /api/rules/:id`
- `GET /api/subscriptions`
- `PATCH /api/subscriptions/:chatId`
- `GET /api/health`
- `POST /api/operator/actions`
- `GET /api/live`

## Canonical Resource Model

### Symbol

- `symbolId`: canonical id such as `BTC`
- `displayName`
- `baseAsset`
- `quoteAsset`
- `supportedExchanges`
- `defaultExchangeScope`

### Dashboard series response

- `symbolId`
- `range`
- `bucketSize`
- `priceSeries[]`
- `oiSeries[]`
- `oiByExchangeSeries[]`
- `signalMarkers[]`
- `freshness`

### Rule

- `ruleId`
- `symbolId`
- `type`: `spike | drop | divergence | dispersion`
- `enabled`
- `scope`: `single_exchange | exchange_list | all_exchanges`
- `exchangeIds[]`
- `thresholds`
- `cooldownMinutes`
- `noiseSuppression`

### Subscription

- `chatId`
- `symbolId`
- `ruleTypes[]`
- `exchangeScope`
- `mutedUntil`

### Health

- `overallStatus`
- `exchangeStatuses[]`
- `lastIngestAt`
- `maxLagSeconds`
- `activeSymbols`
- `activeRules`
- `deliveryQueueDepth`

## Endpoint Contract

### `GET /api/symbols`

Purpose:
- populate filters and show exchange availability

Query params:
- `scope=tracked|all`

Response:
```json
{
  "items": [
    {
      "symbolId": "BTC",
      "displayName": "BTC/USDT",
      "supportedExchanges": ["binance", "bybit", "okx"],
      "defaultExchangeScope": "all_exchanges"
    }
  ]
}
```

### `GET /api/dashboard/series`

Purpose:
- power the main chart and filter state

Query params:
- `symbolId`
- `range=24h|7d|30d|90d`
- `exchangeScope=all_exchanges|single_exchange|exchange_list`
- `exchangeIds=binance,bybit`
- `metrics=price,oi,oi_by_exchange,signals`

Response:
```json
{
  "symbolId": "BTC",
  "range": "7d",
  "bucketSize": "5m",
  "priceSeries": [{ "ts": "2026-04-10T12:00:00Z", "value": 84250.5 }],
  "oiSeries": [{ "ts": "2026-04-10T12:00:00Z", "value": 1823400000 }],
  "oiByExchangeSeries": [
    {
      "exchangeId": "binance",
      "points": [{ "ts": "2026-04-10T12:00:00Z", "value": 740000000 }]
    }
  ],
  "signalMarkers": [
    {
      "signalId": "sig_123",
      "type": "divergence",
      "ts": "2026-04-10T13:20:00Z",
      "severity": "high",
      "exchangeIds": ["binance", "bybit"]
    }
  ],
  "freshness": {
    "overallLagSeconds": 18,
    "worstExchangeId": "okx"
  }
}
```

### `GET /api/signals`

Purpose:
- power recent alerts history and dashboard marker drilldown

Query params:
- `symbolId`
- `type`
- `exchangeIds`
- `from`
- `to`
- `limit`

### `GET /api/rules`

Purpose:
- load alert rules for list/detail/edit views

Query params:
- `symbolId`
- `enabled=true|false`

### `POST /api/rules`

Purpose:
- create a rule from frontend forms

Body:
```json
{
  "symbolId": "BTC",
  "type": "spike",
  "scope": "exchange_list",
  "exchangeIds": ["binance", "bybit"],
  "thresholds": { "zScore": 2.0, "minPctChange": 0.5 },
  "cooldownMinutes": 30,
  "noiseSuppression": { "minVolumeUsd": 5000000 }
}
```

### `PATCH /api/rules/:id`

Purpose:
- enable, disable, retune, or rescope an existing rule

Allowed mutations:
- `enabled`
- `exchangeIds`
- `thresholds`
- `cooldownMinutes`
- `noiseSuppression`

### `GET /api/subscriptions`

Purpose:
- show chat-to-symbol subscription state in admin UI

Query params:
- `symbolId`
- `chatId`

### `PATCH /api/subscriptions/:chatId`

Purpose:
- mutate chat subscription state from frontend admin UI

Body:
```json
{
  "symbolId": "BTC",
  "ruleTypes": ["spike", "divergence"],
  "exchangeScope": "all_exchanges",
  "mutedUntil": null
}
```

### `GET /api/health`

Purpose:
- render health panel and freshness badges

Response:
```json
{
  "overallStatus": "healthy",
  "maxLagSeconds": 18,
  "exchangeStatuses": [
    {
      "exchangeId": "binance",
      "status": "healthy",
      "lastIngestAt": "2026-04-10T15:18:55Z",
      "lagSeconds": 7
    }
  ],
  "deliveryQueueDepth": 0
}
```

### `POST /api/operator/actions`

Purpose:
- keep operational mutations explicit without exploding endpoint count

Supported actions:
- `pause_rule`
- `resume_rule`
- `mute_symbol`
- `replay_recent_alerts`
- `refresh_symbol_catalog`
- `rerun_signal_detection`
- `ack_health_warning`

Body:
```json
{
  "action": "replay_recent_alerts",
  "payload": {
    "symbolId": "BTC",
    "limit": 10
  }
}
```

### `GET /api/live`

Purpose:
- SSE endpoint for incremental UI refresh

Event types:
- `signal.created`
- `signal.normalized`
- `rule.updated`
- `subscription.updated`
- `health.updated`
- `ingestion.stale`

## Frontend Actions

The frontend should be built around these operator actions:

- select symbol
- switch exchange scope
- change time range
- filter signal types
- inspect signal details
- create rule
- pause or resume rule
- mute noisy symbol temporarily
- replay recent missed alerts
- inspect per-exchange freshness
- inspect subscription state per Telegram chat

Recommended explicit action payloads:

```ts
type OperatorAction =
  | { type: "ack_event"; eventId: string }
  | { type: "pause_rule"; ruleId: string; until: string }
  | { type: "resume_rule"; ruleId: string }
  | { type: "test_rule"; ruleId: string }
  | {
      type: "refresh_workspace";
      symbolId: string;
      exchanges?: string[];
      range?: "1h" | "4h" | "24h" | "7d" | "30d";
      resolution?: "1m" | "5m" | "15m" | "1h";
    }
  | {
      type: "set_dashboard_selection";
      symbolId: string;
      exchangeScope: { mode: "single" | "list" | "all"; exchangeIds: string[] };
      range: "1h" | "4h" | "1d" | "1w" | "1m";
    };
```

If frontend delivery speed becomes the top priority, add a thin convenience layer:

- `GET /api/workspace`
- `POST /api/workspace/actions`
- `GET /api/events?after=<cursor>`

This BFF-style layer should remain optional and sit on top of the resource contract above, not replace it.

## Screen Flow

### Dashboard

- load symbols
- load dashboard series
- open live stream
- filter by symbol, range, exchange scope, signal type

### Rules

- list rules
- create rule
- patch rule thresholds or cooldown
- pause/resume rule

### Subscriptions

- view Telegram chats and symbol coverage
- patch subscription state
- inspect muted state

### Health

- view overall freshness
- drill into exchange degradation
- acknowledge warnings
- trigger replay or refresh action if needed

## What the Frontend Must Not Know

- exchange-specific raw tickers
- polling cadence per exchange
- detector implementation details
- cooldown state machine internals
- database storage layout

## Recommendation for Implementation

Start with the recommended hybrid contract and keep all chart views backed by a single `dashboard/series` read-model. That gives the UI one stable screen-loading path while keeping rules, subscriptions, and health as clean reusable resources.
