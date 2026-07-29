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
  # 8 vCPU / 32 GB / 640 GB SSD, $192/mo — the largest disk on a basic plan.
  # (Was s-8vcpu-32gb-amd: same CPU/RAM, 400 GB, $168.) True 16/32 only exists
  # CPU-optimized (c-16, $336/mo) — override per-run with TF_VAR_size=c-16.
  #
  # Growing this powers the droplet OFF, resizes, and boots it back up, and DO
  # can never shrink a disk again afterwards. Bulk data belongs on the block
  # volume below instead, which resizes live and both ways.
  default = "s-8vcpu-32gb-640gb-intel" # x86_64 — profiles.nix Linux profile is x86_64
}

variable "volume_gb" {
  type = number
  # Block-storage data volume, billed at $0.10/GB/mo. Unlike the droplet's root
  # disk it attaches live, can grow at any time (up to 16 TB) and survives a
  # droplet resize. DO's agent mounts it at /mnt/kirin_box_data on the box.
  default = 1000
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

  lifecycle {
    # user_data only ever runs on FIRST boot, so later edits to
    # cloud-init.yaml.tftpl can never reach a live box — but OpenTofu sees the
    # hash drift and wants to replace (destroy!) the droplet to deliver it.
    # Ignoring it keeps `box:up` idempotent on an existing, diverged box; a
    # fresh box still gets the current template at create time.
    ignore_changes = [user_data]
  }
}

# Data volume. Attaches live (no droplet downtime) and is grown with a plain
# `TF_VAR_volume_gb=<bigger> tofu apply` — DO only ever grows a volume, never
# shrinks it. DO's droplet agent mounts it at /mnt/<name>_data on attach; the
# matching UUID line in /etc/fstab (added with `nofail`, so a detached volume
# can't wedge boot) is a runtime step rather than part of cloud-init.yaml.tftpl,
# because that template is shared with AWS/OCI, which have no equivalent.
resource "digitalocean_volume" "data" {
  region                  = var.region
  name                    = "${var.name}-data"
  size                    = var.volume_gb
  initial_filesystem_type = "ext4"
  description             = "Workspace + caches for ${var.name}"
}

resource "digitalocean_volume_attachment" "data" {
  droplet_id = digitalocean_droplet.box.id
  volume_id  = digitalocean_volume.data.id
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

output "data_volume" {
  value = "${digitalocean_volume.data.name} (${digitalocean_volume.data.size} GB) — /dev/disk/by-id/scsi-0DO_Volume_${digitalocean_volume.data.name}"
}
