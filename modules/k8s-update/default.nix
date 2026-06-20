{ trivialBuilders, nixpkgs }:

let name = "k8s-update"; in
let version = "1.0.0"; in
let script = builtins.readFile ./default.sh; in
let k8s-merge = import ../k8s-merge/default.nix { inherit trivialBuilders nixpkgs; }; in
trivialBuilders.writeShellApplication {
  inherit name version;
  runtimeShell = "${nixpkgs.bash}/bin/bash";
  runtimeInputs = (
    with nixpkgs;
    [
      awscli2
      coreutils
      gnused
      jq
      oci-cli
      tailscale
      yq-go
    ]
  ) ++ [ k8s-merge ];
  text = script;
}
