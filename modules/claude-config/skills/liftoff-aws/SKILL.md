---
name: liftoff-aws
description: AWS and Terraform via loctl. Use when checking AWS resources, S3 buckets, EKS clusters, or running terraform plans.
---

# AWS via loctl

## Tools: aws, terraform

## Safety

- DevOpsRole blocked in all arguments
- `AWS_PROFILE` forced to `vungle2-EngineeringRole`
- terraform: only safe commands allowed (plan, show, validate, etc.)

## aws

```bash
loctl qa aws sts get-caller-identity
loctl ops aws s3 ls
loctl ops aws eks describe-cluster --name eks-prod-us-east-1b --region us-east-1
```

## terraform

Requires `tfswitch` to manage versions. Run `tfswitch` before terraform commands. `AWS_PROFILE` is forced to EngineeringRole.

```bash
tfswitch
loctl qa terraform plan
loctl ops terraform show
loctl ops terraform validate
```
