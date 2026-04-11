{ nixpkgs }:
with nixpkgs;
let trivialBuilders = import ./trivialBuilders.nix { inherit lib stdenv stdenvNoCC lndir runtimeShell shellcheck; }; in
rec {
  backup-folder = import ./backup-folder/default.nix { inherit nixpkgs trivialBuilders; };
  setup-pcloud-remote = import ./setup-pcloud-remote/default.nix { inherit nixpkgs trivialBuilders; };
  k8s-update = import ./k8s-update/default.nix { inherit nixpkgs trivialBuilders; };
  load-secrets = import ./load-secrets/default.nix { inherit nixpkgs trivialBuilders; };
  gawt = import ./gawt/default.nix { inherit nixpkgs trivialBuilders; };
  speak = import ./speak/default.nix { inherit trivialBuilders nixpkgs; };
  hms = import ./hms/default.nix { inherit trivialBuilders nixpkgs; };
  kloop = import ./kloop-ts/default.nix { inherit nixpkgs; };
  kloop-dev = nixpkgs.writeShellScriptBin "kloop-dev" ''
    exec ${nixpkgs.bun}/bin/bun run ~/.config/home-manager/modules/kloop-ts/src/index.ts "$@"
  '';
  # kautopilot = import ./kautopilot-ts/default.nix { inherit nixpkgs; };
  kautopilot = nixpkgs.writeShellScriptBin "kautopilot" ''
    exec ${nixpkgs.bun}/bin/bun run ~/.config/home-manager/modules/kautopilot-ts/src/index.ts "$@"
  '';
}
