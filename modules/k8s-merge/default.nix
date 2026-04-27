{ trivialBuilders, nixpkgs }:

let name = "k8s-merge"; in
let version = "1.0.0"; in
let script = builtins.readFile ./default.sh; in
trivialBuilders.writeShellApplication {
  inherit name version;
  runtimeShell = "${nixpkgs.bash}/bin/bash";
  runtimeInputs = with nixpkgs; [
    coreutils
    findutils
    kubectl
  ];
  text = script;
}
