---
name: liftoff-ops
description: 'Umbrella entry point for Liftoff infrastructure access via loctl: Kubernetes, Mimir, Loki, Grafana, ArgoCD, AWS, Helm, Terraform. Use when investigating PE tickets or debugging production infrastructure, then load the matching liftoff-* sub-skill for detail. Never call kubectl/helm/aws/argocd directly.'
---

# loctl -- Infrastructure Access

CLI proxy for Liftoff infrastructure. Verbs are gated **client-side** (per-tool allow-lists); the AWS role comes from `~/.loctl/config.yaml` (default `vungle2-EngineeringRole`, switchable with `loctl role <name>`). Server-side safety is only whatever RBAC/IAM the configured role carries.

## Rules

1. **ALWAYS use loctl** -- never call kubectl, helm, aws, logcli, etc. directly
2. **NEVER mutate infrastructure.** Most mutating verbs are blocked client-side, but `kubectl exec`/`debug`/`port-forward`/`wait` ARE allowed for investigation and CAN mutate -- never use them to change state. A `--help` flag anywhere in the args bypasses verb checks entirely.
3. **Know your role** -- check with `loctl role` (or `loctl <env> doctor`). If the active role is DevOpsRole, you hold write-capable credentials; treat every command with extra care.
4. **`qa` or `ops` prefix is required** -- no default environment. The prefix only routes observability/ArgoCD endpoints; kubectl/helm/stern reach the same contexts either way (`--context` picks the cluster).
5. **Specify `--context`** for kubectl/helm/stern (no default)
6. **Use `loctl <env> logs <tenant> <cmd>`** for Loki queries (tenant is a positional arg)

## Quick Start

```bash
loctl help
loctl role                 # show active + available AWS roles
loctl qa doctor            # check prerequisites (binaries, creds, cluster access)
loctl qa list contexts     # kube cluster contexts
loctl ops list tenants     # Loki tenant IDs for ops
loctl qa list envs         # qa, ops
```

## Available Sub-Skills

- **liftoff-kubernetes** -- kubectl / helm / stern (pods, resources, cluster logs)
- **liftoff-observability** -- Mimir metrics, Loki logs, Grafana dashboards
- **liftoff-aws** -- aws CLI and allow-listed terraform
- **liftoff-argocd** -- deployment status, sync health, app history
