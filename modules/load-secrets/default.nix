{ trivialBuilders, nixpkgs }:

let name = "load-secrets"; in
let version = "1.0.0"; in
let script = builtins.readFile ./default.sh; in
trivialBuilders.writeShellApplication {
  name = name;
  version = version;
  runtimeShell = "${nixpkgs.bash}/bin/bash";
  runtimeInputs = (
    with nixpkgs;
    [
      coreutils
      sops
      age
      yq-go
      gnupg
      gawk
      gnugrep
    ]
  );
  text = script;
}
