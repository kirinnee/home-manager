{ trivialBuilders, nixpkgs, sdm }:

let name = "k8s-sdm"; in
let version = "1.0.0"; in
let script = builtins.readFile ./default.sh; in
trivialBuilders.writeShellApplication {
  name = name;
  version = version;
  runtimeShell = "${nixpkgs.bash}/bin/sh";
  runtimeInputs = (
    with nixpkgs;
    [ coreutils sdm gawk findutils ]
  );
  text = script;
}
