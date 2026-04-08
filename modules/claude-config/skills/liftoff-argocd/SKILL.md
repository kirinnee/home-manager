---
name: liftoff-argocd
description: ArgoCD via loctl. Use when checking deployment status, sync health, or app history.
---

# ArgoCD via loctl

## Environment Routing

- qa: `--server argocd.qa.vungle.io`
- ops: `--server argocd.ops.vungle.io`

The `--server` flag is automatically prepended.

## Safety

- DevOpsRole blocked in all arguments

## Usage

```bash
loctl qa argocd app list
loctl ops argocd app list
loctl qa argocd app get argocd/argocd-eks-secret-eks-qa-us-east-1b
```

## Authentication

Requires prior `argocd login` in a human terminal:

```bash
argocd login argocd.ops.vungle.io
```
