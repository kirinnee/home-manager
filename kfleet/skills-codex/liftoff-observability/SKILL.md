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

The authoritative tenant list is `loctl <env> list tenants`. The tables below add purpose annotations.

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

- grafanactl: only `resources` is allowed at the top level, and only `resources <list|get|pull|serve|validate>`; every other grafanactl command (push, delete, edit, config, ...) is blocked client-side
- promtool: `push`, `test`, `tsdb` blocked
- A `--help` flag anywhere in the args bypasses these checks

## grafanactl

Read-oriented access to Grafana dashboards and resources. Requires service account tokens: `GRAFANA_TOKEN_QA` for qa, `GRAFANA_TOKEN_OPS` for ops.

```bash
loctl qa grafanactl resources get dashboards
loctl ops grafanactl resources get dashboards
loctl ops grafanactl resources get dashboards/<uid>
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
loctl ops logs dmx-logs query '{service_name="<service>"}' --limit=10
loctl ops logs dmx-logs query '{service_name="<service>"} |= "error"' --limit=10
loctl ops logs dmx-logs query '{service_name="<service>"} |= "error"' --since=1h
loctl ops logs dmx-logs instant 'count_over_time({service_name="<service>"}[5m])'
loctl ops logs dmx-logs series '{namespace="<namespace>"}'
```

Flags: `--limit=N` (default 30), `--since=DURATION`, `--from=TIME`, `--to=TIME`, `--direction=forward|backward`, `-o default|raw|jsonl`, `-q` (quiet), `-z TZ`

### Best Practices

- Always specify `--limit` (start with 10)
- Use `|= "error"` (exact match, fast) before `|~ "err.*"` (regex, slow)
- Label filters are fast; full-text requires scanning — filter by labels first
- Use `--since` or `--from`/`--to` for time ranges
- Broad queries like `{cluster=~".+"}` are very slow — use specific label values
