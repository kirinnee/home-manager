{ nixpkgs }:
with nixpkgs;
let
  trivialBuilders = import ./trivialBuilders.nix { inherit lib stdenv stdenvNoCC lndir runtimeShell shellcheck; };
in
rec {
  backup-folder = import ./backup-folder/default.nix { inherit nixpkgs trivialBuilders; };
  k8s-update = import ./k8s-update/default.nix { inherit nixpkgs trivialBuilders; };
  k8s-merge = import ./k8s-merge/default.nix { inherit nixpkgs trivialBuilders; };
  oci-oke-allow-my-ip = import ./oci-oke-allow-my-ip/default.nix { inherit nixpkgs trivialBuilders; };
  load-secrets = import ./load-secrets/default.nix { inherit nixpkgs trivialBuilders; };
  hms = import ./hms/default.nix { inherit trivialBuilders nixpkgs; };
  # loctl: run-from-source wrapper (matches the old `loctl-wrapper` package, which
  # bundled no extra tools and relied on host PATH). Replaces the `loctl` flake
  # input — a `path:` input copied the whole 328MB checkout (node_modules + compiled
  # binaries) into the store on every eval. node_modules lives at the loctl checkout,
  # so bun resolves deps there; assets.ts resolves assets from the source tree.
  loctl = nixpkgs.writeShellScriptBin "loctl" ''
    exec ${nixpkgs.bun}/bin/bun run "$HOME/Workspace/work/vungle/loctl/src/index.ts" "$@"
  '';
}
