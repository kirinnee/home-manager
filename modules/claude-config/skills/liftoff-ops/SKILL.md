---
name: liftoff-ops
description: Use loctl when accessing infrastructure: Kubernetes, Mimir, Loki, Grafana, ArgoCD, Vault, AWS, Helm, Terraform. Use when investigating PE tickets, checking pod health, querying metrics/logs, or debugging production issues.
---

# loctl -- Infrastructure Access

Read-only CLI wrapper. Enforces EngineeringRole. All details in group docs below.

## Rules

1. **ALWAYS use loctl** -- never call kubectl, helm, aws, logcli, etc. directly
2. **NEVER attempt mutations** -- blocked client-side and server-side
3. **Specify `--context`** for kubectl/helm/stern (no default)
4. **Set `LOKI_ORG_ID`** for logcli (Loki is multi-tenant; `loctl list tenants`)
5. **`ops` prefix** for prod (`loctl ops kubectl ...`), default is qa

## Quick Start

```bash
loctl list contexts     # kube cluster contexts
loctl list tenants      # Loki tenant IDs
loctl list envs         # qa, ops
```

## Group Docs

Read the doc for the group you need before using its tools:

- **Kubernetes** (kubectl, helm, stern): `/Users/erng/.loctl/docs/kubernetes.md`
- **AWS** (aws, terraform): `/Users/erng/.loctl/docs/aws.md`
- **ArgoCD** (argocd): `/Users/erng/.loctl/docs/argocd.md`
- **Observability** (grafanactl, logcli, promtool): `/Users/erng/.loctl/docs/observability.md`

## Environment

Default is qa. Prefix with `ops` for prod:

```bash
loctl kubectl --context eks-qa-us-east-1b get pods -n grafana
loctl ops kubectl --context eks-ops-us-east-1c get pods -n grafana
```
