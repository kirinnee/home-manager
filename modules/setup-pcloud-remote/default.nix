{ trivialBuilders, nixpkgs ? import <nixpkgs> { } }:

let name = "setup-rclone-pcloud"; in
let version = "1.0.0"; in
let script = builtins.readFile ./default.sh; in
trivialBuilders.writeShellApplication {
  name = name;
  version = version;
  runtimeShell = "${nixpkgs.bash}/bin/sh";
  runtimeInputs = (
    with nixpkgs;
    [ coreutils ]
  );
  text = script;
}
