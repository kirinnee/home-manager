# Task: Create `k8s-agent-update` Home-Manager Module

## Goal

Create a home-manager module that generates `~/.kube/agent-config` — a read-only kubeconfig using `EngineeringRole` instead of `DevOpsRole`. This gives AI agents safe, read-only Kubernetes access across all Liftoff EKS clusters.

## Background

- Existing module `k8s-update` generates `~/.kube/config` by flattening YAML files from `~/.kube/configs/`
- Each kubeconfig YAML hardcodes `AWS_PROFILE: vungle2-DevOpsRole` (full admin)
- `EngineeringRole` is verified read-only: all reads work, all writes blocked, exec allowed
- We need a parallel set of kubeconfigs with `EngineeringRole` flattened into a single file

## Implementation

### 1. Create `modules/k8s-agent-update/default.sh`

```bash
#!/bin/sh

echo "🛠 Generating agent kubeconfig (read-only, EngineeringRole)"
mkdir -p "$HOME/.kube/agent-configs"

# Clean previous agent configs
rm -f "$HOME/.kube/agent-configs"/*.yaml
rm -f "$HOME/.kube/agent-config"

# Copy and transform each kubeconfig
DIRECTORY="$HOME/.kube/configs"
for file in "$DIRECTORY"/*.yaml; do
  if [ -f "$file" ]; then
    basename=$(basename "$file")
    echo "Processing $basename → agent-configs/$basename"

    # Copy and replace DevOpsRole with EngineeringRole
    sed 's/vungle2-DevOpsRole/vungle2-EngineeringRole/g' "$file" > "$HOME/.kube/agent-configs/$basename"
  fi
done

# Also process k3d configs if they exist
K3D_DIRECTORY="$HOME/.kube/k3dconfigs"
if [ -d "$K3D_DIRECTORY" ] && [ "$(ls -A "$K3D_DIRECTORY"/*.yaml 2>/dev/null)" ]; then
  for file in "$K3D_DIRECTORY"/*.yaml; do
    if [ -f "$file" ]; then
      basename=$(basename "$file")
      echo "Processing k3d $basename → agent-configs/$basename"
      cp "$file" "$HOME/.kube/agent-configs/$basename"
    fi
  done
fi

# Flatten all agent configs into single file
KUBECONFIG=$(find "$HOME/.kube/agent-configs" -name "*.yaml" 2>/dev/null | awk 'ORS=":"') kubectl config view --flatten > "$HOME/.kube/agent-config"
chmod 600 "$HOME/.kube/agent-config"
echo "✅ agent kubeconfig generated at ~/.kube/agent-config"
```

### 2. Create `modules/k8s-agent-update/default.nix`

Follow the exact same pattern as `modules/k8s-update/default.nix`:

```nix
{ trivialBuilders, nixpkgs }:

let name = "k8s-agent-update"; in
let version = "1.0.0"; in
let script = builtins.readFile ./default.sh; in
trivialBuilders.writeShellApplication {
  name = name;
  version = version;
  runtimeShell = "${nixpkgs.bash}/bin/sh";
  runtimeInputs = (
    with nixpkgs;
    [ coreutils gawk findutils gnused kubectl ]
  );
  text = script;
}
```

Note: Added `gnused` (for the sed replacement) and `kubectl` (for `kubectl config view --flatten`) to runtimeInputs.

### 3. Register in `modules/default.nix`

Add to the `rec` set:

```nix
k8s-agent-update = import ./k8s-agent-update/default.nix { inherit nixpkgs trivialBuilders; };
```

### 4. Add to `home-template.nix` packages

Add `k8s-agent-update` to the packages list (near line 321 where `k8s-update` is):

```nix
k8s-agent-update
```

## Verification

After `hms` (home-manager switch):

```bash
# Generate the agent kubeconfig
k8s-agent-update

# Verify it exists and uses EngineeringRole
grep -c "EngineeringRole" ~/.kube/agent-config   # Should show matches
grep -c "DevOpsRole" ~/.kube/agent-config         # Should show 0

# Test read (should work)
KUBECONFIG=~/.kube/agent-config kubectl --context eks-ops-us-east-1c get pods -n grafana

# Test write (should fail with Forbidden)
KUBECONFIG=~/.kube/agent-config kubectl --context eks-ops-us-east-1c delete pod FAKE -n grafana
```

## Reference Files

- Existing module to copy pattern from: `modules/k8s-update/default.nix` and `modules/k8s-update/default.sh`
- Module registry: `modules/default.nix`
- Package list: `home-template.nix` (search for `k8s-update` to find the right location)
