{ trivialBuilders, nixpkgs }:

let name = "oci-k8s-update"; in
let version = "1.0.0"; in
let script = builtins.readFile ./default.sh; in
trivialBuilders.writeShellApplication {
  inherit name version;
  runtimeShell = "${nixpkgs.bash}/bin/bash";
  runtimeInputs = with nixpkgs; [
    coreutils
    gnused
    jq
    oci-cli
    yq-go
  ];
  text = script;
}
