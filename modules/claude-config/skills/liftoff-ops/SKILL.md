---
name: liftoff-ops
description: Query Liftoff infrastructure (Kubernetes, Mimir, Loki, ArgoCD, Vault, AWS) via loctl. Use when investigating PE tickets, checking pod health, querying metrics/logs, or debugging production issues.
---

# Liftoff Operations -- Infrastructure Access via loctl

loctl is a read-only CLI wrapper that enforces EngineeringRole for safe infrastructure access.

## Rules

1. **ALWAYS use loctl** -- never use kubectl, helm, aws, logcli, promtool, argocd, or vault directly
2. **NEVER attempt mutations** -- loctl blocks mutating verbs client-side; EngineeringRole blocks server-side
3. **Specify --context** for kubectl, helm, and stern -- there is no default context
4. **Specify LOKI_ORG_ID** for logcli -- Loki is multi-tenant
5. **Use `loctl qa ...`** prefix when investigating QA environment

## Prerequisites

Run once after kubeconfig changes:

```bash
loctl setup
```

## Discovery

```bash
loctl list contexts    # Available Kubernetes cluster contexts
loctl list tenants     # Available Loki tenant IDs
loctl list envs        # Available environments (ops, qa)
```

Context names are usable as:

- `--context` values for kubectl/helm/stern
- `cluster` label values in PromQL/LogQL queries

## Environment Prefix

Default is ops/prod. Prefix with `qa` for QA endpoints:

```bash
loctl kubectl --context eks-ops-us-east-1c get pods -n grafana       # ops/prod
loctl qa kubectl --context eks-qa-us-east-1b get pods -n grafana     # qa
loctl promtool query instant 'up'                                     # ops Mimir
loctl qa promtool query instant 'up'                                  # qa Mimir
```

## Kubernetes (kubectl)

```bash
# List pods
loctl kubectl --context eks-ops-us-east-1c get pods -n grafana

# Describe a resource
loctl kubectl --context eks-prod-us-east-1b describe deploy my-app -n default

# Stream logs
loctl kubectl --context eks-ops-us-east-1c logs deploy/mimir-ingester -n grafana --tail=100

# Exec into a pod (allowed for investigation)
loctl kubectl --context eks-ops-us-east-1c exec -it pod/mimir-ingester-0 -n grafana -- /bin/sh

# Events sorted by time
loctl kubectl --context eks-ops-us-east-1c get events -n grafana --sort-by=.lastTimestamp

# QA cluster
loctl qa kubectl --context eks-qa-us-east-1b get pods -n grafana
```

## Log Streaming (stern)

```bash
loctl stern --context eks-prod-us-east-1b my-app -n default --only-log-lines -o raw
```

## Helm (read-only)

```bash
# List releases
loctl helm --context eks-ops-us-east-1c list -n grafana

# Show release values
loctl helm --context eks-ops-us-east-1c get values mimir -n grafana

# Show release history
loctl helm --context eks-ops-us-east-1c history mimir -n grafana
```

## Metrics -- Mimir via promtool (PromQL)

Server URL is auto-injected. Just provide the query:

```bash
# Instant query
loctl promtool query instant 'up{cluster="eks-prod-us-east-1b"}'

# Range query
loctl promtool query range 'rate(http_requests_total[5m])' --start=2h --end=now --step=1m

# QA Mimir
loctl qa promtool query instant 'up{cluster="eks-qa-us-east-1b"}'
```

## Logs -- Loki via logcli (LogQL)

Must set `LOKI_ORG_ID` to the tenant. Use `loctl list tenants` for valid values.

```bash
# Query logs
LOKI_ORG_ID=kafka loctl logcli query '{cluster="eks-ops-us-east-1c"}' --limit=100

# List available labels
LOKI_ORG_ID=kafka loctl logcli labels

# Label values
LOKI_ORG_ID=sdk-logs loctl logcli labels service_name

# QA Loki
LOKI_ORG_ID=kafka loctl qa logcli query '{cluster="eks-qa-us-east-1b"}' --limit=100
```

### Loki Best Practices

- Always specify `--limit` (start with 100, expand as needed)
- Use `|= "error"` (exact match, fast) before `|~ "err.*"` (regex, slow)
- Label filters are fast; full-text requires scanning -- filter by labels first
- Order filters by selectivity (most selective first)
- Use `--from` and `--to` for time ranges to avoid scanning full retention

## ArgoCD

```bash
# List all apps
loctl argocd app list

# Get app details
loctl argocd app get my-app

# Check sync status (JSON)
loctl argocd app get my-app -o json

# App history
loctl argocd app history my-app

# QA ArgoCD
loctl qa argocd app list
```

## Vault

Requires a valid `VAULT_TOKEN` from `vaultlogin` (browser OIDC). Agents cannot self-authenticate.

```bash
# Read a secret path
loctl vault kv get secret/my-app

# List secret paths
loctl vault kv list secret/
```

## AWS

```bash
# Identity check
loctl aws sts get-caller-identity

# S3 listing
loctl aws s3 ls

# EKS cluster info
loctl aws eks describe-cluster --name eks-prod-us-east-1b --region us-east-1

# EC2 instances
loctl aws ec2 describe-instances --region us-east-1 --filters "Name=instance-state-name,Values=running"
```

## Investigation Workflow

For PE ticket investigation, follow this sequence:

### 1. Orient -- Identify relevant clusters and namespaces

```bash
loctl list contexts
loctl kubectl --context CTX get namespaces
```

### 2. Check Resource Health

```bash
loctl kubectl --context CTX get pods -n NS
loctl kubectl --context CTX get events -n NS --sort-by=.lastTimestamp
loctl kubectl --context CTX describe pod POD -n NS
```

### 3. Query Metrics (Mimir)

```bash
loctl promtool query instant 'up{cluster="CTX", namespace="NS"}'
loctl promtool query instant 'kube_pod_status_phase{cluster="CTX", namespace="NS", phase!="Running"}'
```

### 4. Query Logs (Loki)

```bash
LOKI_ORG_ID=TENANT loctl logcli query '{cluster="CTX", namespace="NS"} |= "error"' --limit=100
```

### 5. Check Deployments (ArgoCD)

```bash
loctl argocd app list
loctl argocd app get APP_NAME
```

### 6. Correlate

Overlay timelines: deployment events, metric spikes, log errors.
Check helm release history for recent changes:

```bash
loctl helm --context CTX history RELEASE -n NS
```

## Troubleshooting

| Issue                       | Solution                                                    |
| --------------------------- | ----------------------------------------------------------- |
| "agent-config not found"    | Run `loctl setup`                                           |
| "Mutating verb blocked"     | loctl is read-only; mutations require human intervention    |
| Loki "no org id" error      | Set `LOKI_ORG_ID=<tenant>` -- use `loctl list tenants`      |
| kubectl timeout             | Ensure VPN is connected                                     |
| Vault 403                   | Run `vaultlogin` in a human terminal (requires browser)     |
| "DevOpsRole is not allowed" | Never pass DevOpsRole in any argument                       |
| ArgoCD auth expired         | Run `argocd login argocd.ops.vungle.io` in a human terminal |

## Available Clusters

| Context                  | Environment                             |
| ------------------------ | --------------------------------------- |
| eks-prod-us-east-1b      | Production (US East)                    |
| eks-prod-us-east-1c      | Production (US East)                    |
| eks-prod-us-east-1d      | Production (US East)                    |
| eks-prod-us-east-1f      | Production (US East)                    |
| eks-prod-ap-northeast-1a | Production (APNE)                       |
| eks-stage-us-east-1a     | Staging                                 |
| eks-qa-us-east-1b        | QA                                      |
| eks-ops-us-east-1c       | Operations (Mimir, Grafana, monitoring) |
| eks-ops-ap-northeast-1a  | Operations (APNE)                       |
| eks-data-1a              | Data platform                           |
| eks-dashboard-us-east-1a | Dashboards                              |

## Endpoints

| Service | Ops/Prod                | QA                           |
| ------- | ----------------------- | ---------------------------- |
| Mimir   | mimir.ops.vungle.io     | mimir.qa.vungle.io           |
| Loki    | loki-prod.ops.vungle.io | loki.qa.vungle.io            |
| ArgoCD  | argocd.ops.vungle.io    | argocd.qa.vungle.io          |
| Vault   | vault.ops.vungle.io     | vault.ops.vungle.io (shared) |
| Grafana | grafana-prod.vungle.io  | grafana-qa.vungle.io         |
