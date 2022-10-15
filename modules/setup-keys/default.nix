# Setup SSH and PGP keys
{ trivialBuilders, nixpkgs ? import <nixpkgs> { } }:

let name = "setup-keys"; in
let version = "1.0.0"; in
let script = builtins.readFile ./default.sh; in
trivialBuilders.writeShellApplication {
  name = name;
  version = version;
  runtimeShell = "${nixpkgs.bash}/bin/sh";
  runtimeInputs = (
    with nixpkgs;
    [ coreutils openssh gnupg gnugrep gnused ]
  );
  text = script;
}
