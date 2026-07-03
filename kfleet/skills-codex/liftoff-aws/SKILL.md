---
name: liftoff-aws
description: AWS and Terraform via loctl. Use when checking AWS resources, S3 buckets, EKS clusters, or running terraform plans.
---

# AWS via loctl

## Tools: aws, terraform

The `qa`/`ops` prefix has **no effect** on aws/terraform -- both prefixes use the same credentials and targets (the prefix only routes observability/ArgoCD endpoints).

## Safety

- `AWS_PROFILE` is set to the role in `~/.loctl/config.yaml` (default `vungle2-EngineeringRole`; check/switch with `loctl role`) -- server-side safety is exactly that role's IAM policy
- aws subcommands are **not** gated client-side -- run read/describe/list operations only
- terraform: only allow-listed subcommands run (see below); `apply`, `destroy`, `import`, etc. are blocked client-side
- A `--help` flag anywhere in the args bypasses the terraform gating

## aws

```bash
loctl qa aws sts get-caller-identity
loctl ops aws s3 ls
loctl ops aws eks describe-cluster --name <cluster-name> --region us-east-1
```

## terraform

Allowed subcommands: `init`, `plan`, `show`, `output`, `providers`, `version`, `fmt`, `validate`, `graph`, `state list`, `state show`, `state pull`. Everything else is blocked.

loctl runs the `terraform` binary directly (it never invokes `tfswitch`); the binary must already be installed -- `loctl setup` uses tfswitch to install it.

```bash
loctl qa terraform init
loctl qa terraform plan
loctl ops terraform show
loctl ops terraform state list
loctl ops terraform validate
```
