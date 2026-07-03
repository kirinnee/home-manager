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

- loctl only injects `--server`; argocd subcommands are **not** gated client-side. Stick to read commands: `app list`, `app get`, `app history`.

## Usage

```bash
loctl qa argocd app list
loctl ops argocd app list
loctl qa argocd app get <app-name>
loctl ops argocd app history <app-name>
```

## Authentication

Reads work **anonymously** -- no login is needed, and `loctl auth` deliberately skips `argocd login` because logging in grants write access.

Do **not** run `argocd login`. If read commands fail with 401/permission denied, stop and ask a human: logging in would hand the agent write-capable ArgoCD credentials.
