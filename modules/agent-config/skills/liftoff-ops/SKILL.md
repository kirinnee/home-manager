---
name: liftoff-ops
description: 'Use loctl when accessing infrastructure: Kubernetes, Mimir, Loki, Grafana, ArgoCD, Vault, AWS, Helm, Terraform. Use when investigating PE tickets, checking pod health, querying metrics/logs, or debugging production issues.'
---

# loctl -- Infrastructure Access

Read-only CLI wrapper. Enforces EngineeringRole.

## Rules

1. **ALWAYS use loctl** -- never call kubectl, helm, aws, logcli, etc. directly
2. **NEVER attempt mutations** -- blocked client-side and server-side
3. **`qa` or `ops` prefix is required** -- no default environment
4. **Specify `--context`** for kubectl/helm/stern (no default)
5. **Use `loctl <env> logs <tenant> <cmd>`** for Loki queries (tenant is a positional arg)

## Quick Start

```bash
loctl help
loctl qa list contexts     # kube cluster contexts
loctl ops list tenants      # Loki tenant IDs for ops
loctl qa list envs          # qa, ops
```

## Available Sub-Skills

- **liftoff-kubernetes**: Kubernetes cluster access via loctl (kubectl, helm, stern). Use when checking pod health, inspecting resources, or streaming logs from pods.
- **liftoff-observability**: Observability via loctl (promtool, grafanactl, logs). Use when querying metrics in Mimir, logs in Loki, or browsing Grafana dashboards.
- **liftoff-aws**: AWS and Terraform via loctl. Use when checking AWS resources, S3 buckets, EKS clusters, or running terraform plans.
- **liftoff-argocd**: ArgoCD via loctl. Use when checking deployment status, sync health, or app history.
