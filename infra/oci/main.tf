# Box on OCI (x86_64 E4.Flex, Ubuntu 24.04, own minimal VCN). API-key auth
# creds come from sops via scripts/box/up.sh (TF_VAR_* env); state is local
# and gitignored — manage the box from the machine that made it.

terraform {
  required_providers {
    oci = {
      source = "oracle/oci"
    }
  }
}

provider "oci" {
  tenancy_ocid = var.tenancy_ocid
  user_ocid    = var.user_ocid
  fingerprint  = var.fingerprint
  private_key  = var.private_key
  region       = var.region
}

variable "tenancy_ocid" {
  type = string
}

variable "user_ocid" {
  type = string
}

variable "fingerprint" {
  type = string
}

variable "private_key" {
  type      = string
  sensitive = true
}

variable "region" {
  type    = string
  default = "ap-singapore-1"
}

# Defaults to the tenancy root when empty (fine for a personal tenancy).
variable "compartment_ocid" {
  type    = string
  default = ""
}

variable "name" {
  type    = string
  default = "kirin-box"
}

variable "user" {
  type    = string
  default = "kirin"
}

variable "shape" {
  type    = string
  default = "VM.Standard.E4.Flex" # x86_64 — profiles.nix Linux profile is x86_64 (A1.Flex is ARM)
}

variable "ocpus" {
  type    = number
  default = 2
}

variable "memory_gb" {
  type    = number
  default = 16
}

variable "disk_gb" {
  type    = number
  default = 100
}

variable "ssh_public_key" {
  type = string
}

locals {
  compartment = var.compartment_ocid != "" ? var.compartment_ocid : var.tenancy_ocid
}

data "oci_identity_availability_domains" "ads" {
  compartment_id = local.compartment
}

data "oci_core_images" "ubuntu" {
  compartment_id           = local.compartment
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "24.04"
  shape                    = var.shape
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

resource "oci_core_vcn" "box" {
  compartment_id = local.compartment
  display_name   = var.name
  cidr_blocks    = ["10.0.0.0/16"]
  dns_label      = "box"
}

resource "oci_core_internet_gateway" "box" {
  compartment_id = local.compartment
  vcn_id         = oci_core_vcn.box.id
  display_name   = var.name
}

resource "oci_core_default_route_table" "box" {
  manage_default_resource_id = oci_core_vcn.box.default_route_table_id

  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.box.id
  }
}

resource "oci_core_security_list" "box" {
  compartment_id = local.compartment
  vcn_id         = oci_core_vcn.box.id
  display_name   = "${var.name}-ssh"

  ingress_security_rules {
    description = "SSH"
    protocol    = "6" # TCP
    source      = "0.0.0.0/0"

    tcp_options {
      min = 22
      max = 22
    }
  }

  egress_security_rules {
    description = "all egress"
    protocol    = "all"
    destination = "0.0.0.0/0"
  }
}

resource "oci_core_subnet" "box" {
  compartment_id    = local.compartment
  vcn_id            = oci_core_vcn.box.id
  display_name      = var.name
  cidr_block        = "10.0.0.0/24"
  dns_label         = "pub"
  security_list_ids = [oci_core_security_list.box.id]
}

resource "oci_core_instance" "box" {
  availability_domain = data.oci_identity_availability_domains.ads.availability_domains[0].name
  compartment_id      = local.compartment
  display_name        = var.name
  shape               = var.shape

  shape_config {
    ocpus         = var.ocpus
    memory_in_gbs = var.memory_gb
  }

  source_details {
    source_type             = "image"
    source_id               = data.oci_core_images.ubuntu.images[0].id
    boot_volume_size_in_gbs = var.disk_gb
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.box.id
    assign_public_ip = true
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data = base64encode(templatefile("${path.module}/../cloud-init.yaml.tftpl", {
      user           = var.user
      ssh_public_key = var.ssh_public_key
    }))
  }
}

output "public_ip" {
  value = oci_core_instance.box.public_ip
}

output "user" {
  value = var.user
}
