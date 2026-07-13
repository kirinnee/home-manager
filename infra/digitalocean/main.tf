# Box on a DigitalOcean droplet (x86_64, Ubuntu 24.04). Token comes from sops
# via scripts/box/up.sh (DIGITALOCEAN_TOKEN env); state is local and
# gitignored — manage the box from the machine that made it.

terraform {
  required_providers {
    digitalocean = {
      source = "digitalocean/digitalocean"
    }
  }
}

provider "digitalocean" {}

variable "region" {
  type    = string
  default = "sfo3"
}

variable "name" {
  type    = string
  default = "kirin-box"
}

variable "user" {
  type    = string
  default = "kirin"
}

variable "size" {
  type = string
  # 8 vCPU / 32 GB / 400 GB SSD, $168/mo. True 16/32 only exists CPU-optimized
  # (c-16, $336/mo) — override per-run with TF_VAR_size=c-16 if ever needed.
  default = "s-8vcpu-32gb-amd" # x86_64 — profiles.nix Linux profile is x86_64
}

variable "ssh_public_key" {
  type = string
}

resource "digitalocean_ssh_key" "box" {
  name       = var.name
  public_key = var.ssh_public_key
}

resource "digitalocean_droplet" "box" {
  name     = var.name
  region   = var.region
  image    = "ubuntu-24-04-x64"
  size     = var.size
  ssh_keys = [digitalocean_ssh_key.box.fingerprint]

  user_data = templatefile("${path.module}/../cloud-init.yaml.tftpl", {
    user           = var.user
    ssh_public_key = var.ssh_public_key
  })
}

# SSH-only ingress, same posture as the AWS security group / OCI security list.
resource "digitalocean_firewall" "box" {
  name        = var.name
  droplet_ids = [digitalocean_droplet.box.id]

  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "tcp"
    port_range            = "all"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "udp"
    port_range            = "all"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "icmp"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
}

output "public_ip" {
  value = digitalocean_droplet.box.ipv4_address
}

output "user" {
  value = var.user
}
