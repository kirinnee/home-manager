---
name: liftoff-observability
description: Observability via loctl (promtool, grafanactl, logs). Use when querying metrics in Mimir, logs in Loki, or browsing Grafana dashboards.
---

# Observability via loctl

## Tools: grafanactl, promtool, logs (native Loki client)

## Environment Routing

- **grafanactl**: qa → `https://grafana-dash.qa.vungle.io` (`GRAFANA_TOKEN_QA`), ops → `https://grafana-prod.vungle.io` (`GRAFANA_TOKEN_OPS`)
- **logs**: qa → `http://loki.qa.vungle.io`, ops → `http://loki-prod.ops.vungle.io:30669`
- **promtool**: qa → `http://mimir.qa.vungle.io/prometheus`, ops → `http://mimir.ops.vungle.io/prometheus`

## Loki Tenants

### QA (`loctl qa`)

| Tenant          | Description    |
| --------------- | -------------- |
| `lokiTenantQA1` | QA Loki tenant |

### Ops (`loctl ops`)

| Tenant                   | Description                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------- |
| `dmx-logs`               | **Primary tenant** -- most Kubernetes pod logs and application logs across all clusters |
| `kafka`                  | Kafka broker logs (GC, controller, etc.)                                                |
| `gr-logs`                | Growth & revenue services (account, analyser, feedserver, keycloak, etc.)               |
| `sdk-logs`               | Mobile SDK logs                                                                         |
| `redis`                  | Redis (redis-prod) logs                                                                 |
| `rocksdb`                | RocksDB / KVRocks logs (ddlookup, hbp, loid, winazon, sit)                              |
| `albatross`              | Albatross service logs                                                                  |
| `consul-server-internal` | Consul server internal logs                                                             |
| `creative-dump-logs`     | Creative dump / ad manager logs                                                         |
| `data-all`               | Data platform logs                                                                      |
| `haproxy`                | HAProxy load balancer logs                                                              |
| `hyperouter`             | Hyperouter / Loki source journal                                                        |
| `tailscale-router`       | Tailscale router and vault-agent logs                                                   |
| `valkey`                 | Valkey (Redis-compatible) logs                                                          |

## Safety

- DevOpsRole blocked in all arguments
- grafanactl: only `list`, `get`, `pull`, `serve`, `validate` allowed
- promtool: `push`, `test`, `tsdb` blocked

## grafanactl

Read-only access to Grafana dashboards and resources. Requires service account tokens: `GRAFANA_TOKEN_QA` for qa, `GRAFANA_TOKEN_OPS` for ops.

```bash
loctl qa grafanactl resources list
loctl qa grafanactl resources get dashboards
loctl ops grafanactl resources get dashboards
loctl ops grafanactl resources get dashboards/bloom-build
```

## promtool

Server URL auto-injected. Use `instant` queries (no time args needed). Range queries require RFC3339 timestamps.

```bash
loctl qa promtool query instant 'up{cluster="eks-qa-us-east-1b"}'
loctl ops promtool query instant 'up{cluster="eks-ops-us-east-1c"}'
```

## logs (recommended)

Fast native Loki HTTP client. **No `LOKI_ORG_ID` env var needed** — tenant is a positional argument. Replaces `logcli` for all log queries.

```bash
loctl ops logs dmx-logs labels
loctl ops logs dmx-logs labels service_name
loctl ops logs dmx-logs query '{service_name="scrat"}' --limit=10
loctl ops logs dmx-logs query '{service_name="scrat"} |= "error"' --limit=10
loctl ops logs dmx-logs query '{service_name="scrat"} |= "error"' --since=1h
loctl ops logs dmx-logs instant 'count_over_time({service_name="scrat"}[5m])'
loctl ops logs dmx-logs series '{namespace="api"}'
```

Flags: `--limit=N` (default 30), `--since=DURATION`, `--from=TIME`, `--to=TIME`, `--direction=forward|backward`, `-o default|raw|jsonl`, `-q` (quiet), `-z TZ`

### Best Practices

- Always specify `--limit` (start with 10)
- Use `|= "error"` (exact match, fast) before `|~ "err.*"` (regex, slow)
- Label filters are fast; full-text requires scanning — filter by labels first
- Use `--since` or `--from`/`--to` for time ranges
- Broad queries like `{cluster=~".+"}` are very slow — use specific label values
