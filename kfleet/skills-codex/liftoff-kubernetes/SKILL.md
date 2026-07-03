---
name: liftoff-kubernetes
description: Kubernetes cluster access via loctl (kubectl, helm, stern). Use when checking pod health, inspecting resources, or streaming logs from pods.
---

# Kubernetes via loctl

## Tools: kubectl, helm, stern

## Contexts

The `qa`/`ops` prefix does **not** scope Kubernetes access -- it only routes observability/ArgoCD endpoints. kubectl/helm/stern reach the same set of contexts under either prefix; the `--context` flag is what selects the cluster.

List the authoritative context set with:

```bash
loctl qa list contexts
```

Context name patterns and their purposes:

| Pattern           | Purpose                                 |
| ----------------- | --------------------------------------- |
| `eks-qa-*`        | QA                                      |
| `eks-prod-*`      | Production (us-east, ap-northeast)      |
| `eks-stage-*`     | Staging                                 |
| `eks-ops-*`       | Operations (Mimir, Grafana, monitoring) |
| `eks-data-*`      | Data platform                           |
| `eks-dashboard-*` | Dashboards                              |
| `eks-llm-*`       | LLM workloads                           |

## Safety

- `KUBECONFIG` points at a generated agent config bound to the role in `~/.loctl/config.yaml` (default `vungle2-EngineeringRole`; check/switch with `loctl role`)
- `AWS_PROFILE` is set to that same configured role -- server-side safety is exactly that role's RBAC, nothing more
- Verbs are gated **client-side** via an allow-list; a `--help` flag anywhere in the args bypasses the verb check
- `exec`, `debug`, `port-forward`, and `wait` are allowed but are **not** read-only -- they can mutate state; use them only for read-only investigation, never to change anything

## Rules

- **`qa` or `ops` prefix is required** -- no default
- **Always specify `--context`** -- there is no default
- Available contexts: `loctl qa list contexts`

## kubectl

Allowed verbs: get, describe, logs, top, explain, api-resources, api-versions, version, config, auth, cluster-info, debug, exec, port-forward, wait, diff

Warning: `exec`/`debug`/`port-forward`/`wait` can mutate -- investigation only, never mutation.

```bash
loctl qa kubectl --context eks-qa-us-east-1b get nodes
loctl ops kubectl --context eks-prod-us-east-1b get pods -n api
loctl ops kubectl --context eks-ops-us-east-1c get pods -n grafana
loctl ops kubectl --context eks-ops-us-east-1c get events -n grafana --sort-by=.lastTimestamp
loctl qa kubectl --context eks-qa-us-east-1b top pods -n grafana --sort-by=cpu
```

## helm

Allowed commands: get, history, list, ls, show, status, template, version, search, repo, env, diff

Note: uses `--kube-context` (not `--context`). The configured role may lack RBAC for helm list/status in some namespaces.

```bash
loctl qa helm --kube-context eks-qa-us-east-1b show values argocd
loctl ops helm --kube-context eks-ops-us-east-1c show values mimir
```

## stern

```bash
loctl qa stern --context eks-qa-us-east-1b my-app -n default --tail=10
loctl ops stern --context eks-prod-us-east-1b my-app -n api --tail=10
```
