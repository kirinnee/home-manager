{ trivialBuilders, nixpkgs }:

let name = "loctl"; in
let version = "1.0.0"; in
let script = builtins.readFile ./default.sh; in
trivialBuilders.writeShellApplication {
  name = name;
  version = version;
  runtimeShell = "${nixpkgs.bash}/bin/bash";
  runtimeInputs = (
    with nixpkgs;
    [ coreutils gawk findutils gnused ]
  );
  text = script;
}
