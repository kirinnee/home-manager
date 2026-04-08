---
name: liftoff-kubernetes
description: Kubernetes cluster access via loctl (kubectl, helm, stern). Use when checking pod health, inspecting resources, or streaming logs from pods.
---

# Kubernetes via loctl

## Tools: kubectl, helm, stern

## Cluster Mapping

The `qa` environment maps to QA clusters. The `ops` environment maps to **all non-QA** clusters: production, staging, data platform, dashboard, and operations.

### QA (`loctl qa`)

| Context             | Purpose |
| ------------------- | ------- |
| `eks-qa-us-east-1b` | QA      |

### Ops (`loctl ops`)

| Context                    | Purpose                                 |
| -------------------------- | --------------------------------------- |
| `eks-prod-us-east-1b`      | Production (US East)                    |
| `eks-prod-us-east-1c`      | Production (US East)                    |
| `eks-prod-us-east-1d`      | Production (US East)                    |
| `eks-prod-us-east-1f`      | Production (US East)                    |
| `eks-prod-ap-northeast-1a` | Production (APNE)                       |
| `eks-stage-us-east-1a`     | Staging                                 |
| `eks-ops-us-east-1c`       | Operations (Mimir, Grafana, monitoring) |
| `eks-ops-ap-northeast-1a`  | Operations (APNE)                       |
| `eks-data-1a`              | Data platform                           |
| `eks-dashboard-us-east-1a` | Dashboards                              |

## Safety

- `KUBECONFIG` set to agent-config (EngineeringRole)
- `AWS_PROFILE` forced to EngineeringRole
- DevOpsRole blocked in all arguments
- Mutating verbs (apply, create, delete, patch) blocked client-side

## Rules

- **`qa` or `ops` prefix is required** -- no default
- **Always specify `--context`** -- there is no default
- Available contexts: `loctl qa list contexts`

## kubectl

Read-only verbs: get, describe, logs, top, explain, api-resources, api-versions, version, config, auth, cluster-info, debug, exec, port-forward, wait, diff

```bash
loctl qa kubectl --context eks-qa-us-east-1b get nodes
loctl ops kubectl --context eks-prod-us-east-1b get pods -n api
loctl ops kubectl --context eks-ops-us-east-1c get pods -n grafana
loctl ops kubectl --context eks-ops-us-east-1c get events -n grafana --sort-by=.lastTimestamp
loctl qa kubectl --context eks-qa-us-east-1b top pods -n grafana --sort-by=cpu
```

## helm

Read-only commands: get, history, list, ls, show, status, template, version, search, repo, env, diff

Note: uses `--kube-context` (not `--context`). EngineeringRole may lack RBAC for helm list/status in some namespaces.

```bash
loctl qa helm --kube-context eks-qa-us-east-1b show values argocd
loctl ops helm --kube-context eks-ops-us-east-1c show values mimir
```

## stern

```bash
loctl qa stern --context eks-qa-us-east-1b my-app -n default --tail=10
loctl ops stern --context eks-prod-us-east-1b my-app -n api --tail=10
```
