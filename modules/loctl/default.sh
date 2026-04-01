#!/usr/bin/env bash
set -euo pipefail

##############################################################################
# loctl -- Liftoff Operations Control CLI
#
# Read-only infrastructure wrapper enforcing EngineeringRole.
# Designed for AI agents (kautopilot) investigating PE tickets.
#
# Usage: loctl [qa] <command> [args...]
##############################################################################

# -- Constants ---------------------------------------------------------------

AGENT_KUBECONFIG="$HOME/.kube/agent-config"
AGENT_CONFIGS_DIR="$HOME/.kube/agent-configs"
SOURCE_CONFIGS_DIR="$HOME/.kube/configs"
K3D_CONFIGS_DIR="$HOME/.kube/k3dconfigs"

SAFE_ROLE="vungle2-EngineeringRole"
BLOCKED_ROLE="vungle2-DevOpsRole"

# Loki tenants (multi-tenant, must set LOKI_ORG_ID)
LOKI_TENANTS=(
  albatross consul-server-internal creative-dump-logs data-all dmx-logs
  gr-logs haproxy hyperouter kafka lokiTenantQA1 redis rocksdb sdk-logs
  tailscale-router valkey
)

# kubectl verbs allowed (read-only + exec for investigation)
KUBECTL_SAFE_VERBS="get|describe|logs|top|explain|api-resources|api-versions|version|config|auth|cluster-info|debug|exec|port-forward|wait|diff"

# helm subcommands allowed (read-only)
HELM_SAFE_CMDS="get|history|list|ls|show|status|template|version|search|repo|env|diff"

# -- Environment Endpoints ---------------------------------------------------

set_env_ops() {
  MIMIR_URL="http://mimir.ops.vungle.io/prometheus"
  LOKI_URL="http://loki-prod.ops.vungle.io"
  ARGOCD_SERVER="argocd.ops.vungle.io"
  VAULT_ADDR_DEFAULT="https://vault.ops.vungle.io"
}

set_env_qa() {
  MIMIR_URL="http://mimir.qa.vungle.io/prometheus"
  LOKI_URL="http://loki.qa.vungle.io"
  ARGOCD_SERVER="argocd.qa.vungle.io"
  VAULT_ADDR_DEFAULT="https://vault.ops.vungle.io"
}

# -- Helpers -----------------------------------------------------------------

die() {
  echo "loctl: error: $*" >&2
  exit 1
}

gate_role() {
  for arg in "$@"; do
    if [[ $arg == *"$BLOCKED_ROLE"* ]] || [[ $arg == *"DevOpsRole"* ]]; then
      die "DevOpsRole is not allowed. loctl enforces EngineeringRole (read-only)."
    fi
  done
}

require_agent_config() {
  if [[ ! -f $AGENT_KUBECONFIG ]]; then
    die "$AGENT_KUBECONFIG not found. Run 'loctl setup' first."
  fi
}

# Extract first non-flag argument, skipping flag values.
# Usage: verb=$(extract_verb "--context" "--namespace|-n" -- "$@")
# Pass flag names that take a value argument before --, then the args.
extract_verb() {
  local value_flags=()
  while [[ ${1:-} != "--" ]]; do
    value_flags+=("$1")
    shift
  done
  shift # consume --

  local skip_next=false
  for arg in "$@"; do
    if $skip_next; then
      skip_next=false
      continue
    fi
    # Check if this flag takes a value
    local is_value_flag=false
    for vf in "${value_flags[@]}"; do
      if [[ $arg =~ ^($vf)$ ]]; then
        is_value_flag=true
        skip_next=true
        break
      fi
      if [[ $arg =~ ^($vf)= ]]; then
        is_value_flag=true
        break
      fi
    done
    if $is_value_flag; then
      continue
    fi
    # Skip other flags
    if [[ $arg == -* ]]; then
      continue
    fi
    # First non-flag, non-flag-value arg is the verb
    echo "$arg"
    return
  done
}

usage() {
  cat <<'USAGE'
loctl -- Liftoff Operations Control CLI (read-only, EngineeringRole)

Usage:
  loctl [qa] <command> [args...]

Environment:
  Default is ops/prod. Prefix with 'qa' for QA endpoints.

Commands:
  setup                  Generate ~/.kube/agent-config (EngineeringRole)
  list contexts          List available Kubernetes contexts
  list tenants           List available Loki tenant IDs
  list envs              List available environments
  kubectl [args]         Read-only kubectl (mutating verbs blocked)
  helm [args]            Read-only helm (install/upgrade/delete blocked)
  stern [args]           Log streaming via stern
  logcli [args]          Query Loki (LOKI_ADDR auto-set; set LOKI_ORG_ID for tenant)
  promtool query [args]  Query Mimir (server URL auto-injected)
  argocd [args]          ArgoCD CLI (server auto-set)
  vault [args]           Vault CLI (VAULT_ADDR auto-set)
  aws [args]             AWS CLI (EngineeringRole enforced)
  help                   Show this help

Examples:
  loctl kubectl --context eks-ops-us-east-1c get pods -n grafana
  loctl qa kubectl --context eks-qa-us-east-1b get pods -n grafana
  loctl promtool query instant 'up{cluster="eks-prod-us-east-1b"}'
  LOKI_ORG_ID=kafka loctl logcli query '{cluster="eks-ops-us-east-1c"}'
  loctl argocd app list
USAGE
}

# -- Subcommands -------------------------------------------------------------

cmd_setup() {
  echo "Generating agent kubeconfig (EngineeringRole)..."
  mkdir -p "$AGENT_CONFIGS_DIR"

  # Clean previous
  rm -f "$AGENT_CONFIGS_DIR"/*.yaml
  rm -f "$AGENT_KUBECONFIG"

  local count=0
  for file in "$SOURCE_CONFIGS_DIR"/*.yaml; do
    if [[ -f $file ]]; then
      local base
      base="$(basename "$file")"
      sed "s/$BLOCKED_ROLE/$SAFE_ROLE/g" "$file" >"$AGENT_CONFIGS_DIR/$base"
      count=$((count + 1))
    fi
  done

  # Include k3d configs if present
  if [[ -d $K3D_CONFIGS_DIR ]]; then
    for file in "$K3D_CONFIGS_DIR"/*.yaml; do
      if [[ -f $file ]]; then
        local base
        base="$(basename "$file")"
        cp "$file" "$AGENT_CONFIGS_DIR/$base"
        count=$((count + 1))
      fi
    done
  fi

  if [[ $count -eq 0 ]]; then
    die "No kubeconfig files found in $SOURCE_CONFIGS_DIR"
  fi

  # Flatten into single file
  local kc
  kc="$(find "$AGENT_CONFIGS_DIR" -name "*.yaml" 2>/dev/null | awk 'ORS=":"')"
  KUBECONFIG="$kc" kubectl config view --flatten >"$AGENT_KUBECONFIG"
  chmod 600 "$AGENT_KUBECONFIG"
  echo "Generated $AGENT_KUBECONFIG ($count configs, EngineeringRole)"
}

cmd_list() {
  local what="${1:-}"
  case "$what" in
  contexts | context)
    require_agent_config
    KUBECONFIG="$AGENT_KUBECONFIG" kubectl config get-contexts -o name
    ;;
  tenants | tenant)
    printf '%s\n' "${LOKI_TENANTS[@]}"
    ;;
  envs | env)
    echo "ops (default)"
    echo "qa"
    ;;
  *)
    die "Unknown list target: '$what'. Use 'contexts', 'tenants', or 'envs'."
    ;;
  esac
}

cmd_kubectl() {
  require_agent_config
  gate_role "$@"

  local verb
  verb=$(extract_verb "--context" "--namespace|-n" "--kubeconfig" "--cluster" "--user" "-s|--server" "-o|--output" "--selector|-l" "--sort-by" "--field-selector" "--template" "--container|-c" -- "$@")

  if [[ -n $verb ]] && [[ ! $verb =~ ^($KUBECTL_SAFE_VERBS)$ ]]; then
    die "Mutating verb '$verb' is blocked. Allowed: ${KUBECTL_SAFE_VERBS//|/, }"
  fi

  KUBECONFIG="$AGENT_KUBECONFIG" \
    AWS_PROFILE="$SAFE_ROLE" \
    exec kubectl "$@"
}

cmd_helm() {
  require_agent_config
  gate_role "$@"

  local subcmd
  subcmd=$(extract_verb "--context" "--namespace|-n" "--kubeconfig" "--kube-context" -- "$@")

  if [[ -n $subcmd ]] && [[ ! $subcmd =~ ^($HELM_SAFE_CMDS)$ ]]; then
    die "Helm subcommand '$subcmd' is blocked. Allowed: ${HELM_SAFE_CMDS//|/, }"
  fi

  KUBECONFIG="$AGENT_KUBECONFIG" \
    AWS_PROFILE="$SAFE_ROLE" \
    exec helm "$@"
}

cmd_stern() {
  require_agent_config
  gate_role "$@"

  KUBECONFIG="$AGENT_KUBECONFIG" \
    AWS_PROFILE="$SAFE_ROLE" \
    exec stern "$@"
}

cmd_logcli() {
  gate_role "$@"

  LOKI_ADDR="${LOKI_ADDR:-$LOKI_URL}" \
    exec logcli "$@"
}

cmd_promtool() {
  gate_role "$@"

  # Auto-inject server URL for query subcommands:
  #   loctl promtool query instant 'up' → promtool query instant <MIMIR_URL> 'up'
  if [[ ${1:-} == "query" ]] && [[ ${2:-} =~ ^(instant|range)$ ]]; then
    local query_type="$2"
    shift 2
    exec promtool query "$query_type" "$MIMIR_URL" "$@"
  else
    exec promtool "$@"
  fi
}

cmd_argocd() {
  gate_role "$@"
  exec argocd --server "$ARGOCD_SERVER" "$@"
}

cmd_vault() {
  gate_role "$@"
  VAULT_ADDR="${VAULT_ADDR:-$VAULT_ADDR_DEFAULT}" \
    exec vault "$@"
}

cmd_aws() {
  gate_role "$@"
  AWS_PROFILE="$SAFE_ROLE" \
    exec aws "$@"
}

# -- Main Dispatch -----------------------------------------------------------

main() {
  # Default to ops
  set_env_ops

  # Check for environment prefix
  case "${1:-}" in
  qa)
    set_env_qa
    shift
    ;;
  esac

  local cmd="${1:-help}"
  shift 2>/dev/null || true

  case "$cmd" in
  setup) cmd_setup "$@" ;;
  list) cmd_list "$@" ;;
  kubectl) cmd_kubectl "$@" ;;
  helm) cmd_helm "$@" ;;
  stern) cmd_stern "$@" ;;
  logcli) cmd_logcli "$@" ;;
  promtool) cmd_promtool "$@" ;;
  argocd) cmd_argocd "$@" ;;
  vault) cmd_vault "$@" ;;
  aws) cmd_aws "$@" ;;
  help | --help | -h)
    usage
    ;;
  *) die "Unknown command: '$cmd'. Run 'loctl help' for usage." ;;
  esac
}

main "$@"
