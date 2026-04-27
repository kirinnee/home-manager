#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: oci-oke-allow-my-ip [options]

Maintains one OCI NSG ingress rule that allows this machine's current public
IP to reach the OKE Kubernetes API on TCP/6443.

Behavior:
  - state file missing: add current IP rule and write state
  - state IP unchanged: do nothing
  - state IP changed: delete stored rule ID, add current IP rule, update state

Options:
  --nsg-id OCID        Control-plane NSG OCID. Defaults to OCI_OKE_CONTROL_PLANE_NSG_ID.
  --state-file PATH    Defaults to ~/.oci/oke-admin-ip.json.
  --ip IP              Use IP instead of fetching https://api.ipify.org.
  -h, --help           Show this help.
USAGE
}

nsg_id="${OCI_OKE_CONTROL_PLANE_NSG_ID:-}"
state_file="${OCI_OKE_ADMIN_IP_STATE_FILE:-$HOME/.oci/oke-admin-ip.json}"
current_ip=""
description="Admin to k8s API (managed-by oci-oke-allow-my-ip)"

while [ "$#" -gt 0 ]; do
  case "$1" in
  --nsg-id)
    nsg_id="$2"
    shift
    ;;
  --state-file)
    state_file="$2"
    shift
    ;;
  --ip)
    current_ip="$2"
    shift
    ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    echo "Unknown option: $1" >&2
    usage >&2
    exit 2
    ;;
  esac
  shift
done

if [ -z "$nsg_id" ]; then
  echo "Missing NSG ID. Set OCI_OKE_CONTROL_PLANE_NSG_ID or pass --nsg-id." >&2
  exit 2
fi

if [ -z "$current_ip" ]; then
  current_ip="$(curl -fsS https://api.ipify.org)"
fi

if ! printf '%s\n' "$current_ip" | grep -Eq '^[0-9]+(\.[0-9]+){3}$'; then
  echo "Current IP does not look like IPv4: $current_ip" >&2
  exit 1
fi

previous_ip=""
previous_rule_id=""

if [ -f "$state_file" ]; then
  previous_ip="$(jq -r '.ip // empty' "$state_file")"
  previous_rule_id="$(jq -r '.ruleId // empty' "$state_file")"
fi

if [ "$previous_ip" = "$current_ip" ] && [ -n "$previous_rule_id" ]; then
  echo "OKE admin IP unchanged: $current_ip"
  echo "Rule ID: $previous_rule_id"
  exit 0
fi

if [ -n "$previous_rule_id" ]; then
  echo "Removing previous OKE admin IP rule: $previous_ip ($previous_rule_id)"
  if ! oci network nsg rules remove \
    --nsg-id "$nsg_id" \
    --security-rule-ids "[\"$previous_rule_id\"]" >/dev/null; then
    echo "Warning: failed to remove previous rule $previous_rule_id; continuing." >&2
  fi
fi

rules_file="$(mktemp)"
response_file="$(mktemp)"
trap 'rm -f "$rules_file" "$response_file"' EXIT

jq -n \
  --arg source "$current_ip/32" \
  --arg description "$description" \
  '[
    {
      direction: "INGRESS",
      protocol: "6",
      source: $source,
      sourceType: "CIDR_BLOCK",
      description: $description,
      tcpOptions: {
        destinationPortRange: {
          min: 6443,
          max: 6443
        }
      }
    }
  ]' >"$rules_file"

echo "Adding OKE admin IP rule: $current_ip/32"
oci network nsg rules add \
  --nsg-id "$nsg_id" \
  --security-rules "file://$rules_file" \
  --output json >"$response_file"

rule_id="$(jq -r '.data."security-rules"[0].id // .data[0].id // empty' "$response_file")"
if [ -z "$rule_id" ]; then
  echo "Could not find new rule ID in OCI response." >&2
  cat "$response_file" >&2
  exit 1
fi

mkdir -p "$(dirname "$state_file")"
jq -n \
  --arg ip "$current_ip" \
  --arg ruleId "$rule_id" \
  --arg nsgId "$nsg_id" \
  --arg description "$description" \
  --arg updatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{
    ip: $ip,
    ruleId: $ruleId,
    nsgId: $nsgId,
    description: $description,
    updatedAt: $updatedAt
  }' >"$state_file"
chmod 600 "$state_file"

echo "Updated $state_file"
echo "OKE admin IP allowed: $current_ip/32"
