{ trivialBuilders, nixpkgs }:

let name = "oci-oke-allow-my-ip"; in
let version = "1.0.0"; in
let script = builtins.readFile ./default.sh; in
trivialBuilders.writeShellApplication {
  inherit name version;
  runtimeShell = "${nixpkgs.bash}/bin/bash";
  runtimeInputs = with nixpkgs; [
    coreutils
    curl
    gnugrep
    jq
    oci-cli
  ];
  text = script;
}
