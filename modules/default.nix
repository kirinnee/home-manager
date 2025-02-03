{ nixpkgs }:
with nixpkgs;
let trivialBuilders = import ./trivialBuilders.nix { inherit lib stdenv stdenvNoCC lndir runtimeShell shellcheck; }; in
rec {
  backup-folder = import ./backup-folder/default.nix { inherit nixpkgs trivialBuilders; };
  get-uuid = import ./get-uuid/default.nix { inherit nixpkgs trivialBuilders; };
  register-with-github = import ./register-with-github/default.nix { inherit nixpkgs trivialBuilders get-uuid; };
  set-signing-key = import ./set-signing-key/default.nix { inherit nixpkgs trivialBuilders; };
  setup-devbox-server = import ./setup-devbox-server/default.nix { inherit nixpkgs trivialBuilders set-signing-key setup-keys register-with-github; };
  setup-keys = import ./setup-keys/default.nix { inherit nixpkgs trivialBuilders; };
  setup-pcloud-remote = import ./setup-pcloud-remote/default.nix { inherit nixpkgs trivialBuilders; };
  k8s-update = import ./k8s-update/default.nix { inherit nixpkgs trivialBuilders; };
}
