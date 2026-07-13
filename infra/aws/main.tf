# Box on AWS EC2 (x86_64, Ubuntu 24.04, default VPC). Credentials come from
# sops via scripts/box/up.sh (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY env);
# state is local and gitignored — manage the box from the machine that made it.

terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

provider "aws" {
  region = var.region
}

variable "region" {
  type    = string
  default = "ap-southeast-1"
}

variable "name" {
  type    = string
  default = "kirin-box"
}

variable "user" {
  type    = string
  default = "kirin"
}

variable "instance_type" {
  type    = string
  default = "t3.large" # profiles.nix Linux profile is x86_64 — keep x86 instance types
}

variable "disk_gb" {
  type    = number
  default = 100
}

variable "ssh_public_key" {
  type = string
}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

data "aws_vpc" "default" {
  default = true
}

resource "aws_security_group" "box" {
  name_prefix = "${var.name}-"
  description = "SSH-only ingress for the home-manager box"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "all egress"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = var.name }
}

resource "aws_instance" "box" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  vpc_security_group_ids = [aws_security_group.box.id]

  user_data = templatefile("${path.module}/../cloud-init.yaml.tftpl", {
    user           = var.user
    ssh_public_key = var.ssh_public_key
  })

  root_block_device {
    volume_size = var.disk_gb
    volume_type = "gp3"
  }

  tags = { Name = var.name }
}

output "public_ip" {
  value = aws_instance.box.public_ip
}

output "user" {
  value = var.user
}
