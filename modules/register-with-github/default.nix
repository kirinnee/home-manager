# Register GPG and SSH key with GitHub
{ trivialBuilders, nixpkgs ? import <nixpkgs> { }, get-uuid }:

let name = "register-with-github"; in
let version = "1.0.0"; in
let script = builtins.readFile ./default.sh; in
trivialBuilders.writeShellApplication {
  name = name;
  version = version;
  runtimeShell = "${nixpkgs.bash}/bin/sh";
  runtimeInputs = (
    with nixpkgs;
    [ coreutils curl gnused gnupg git get-uuid ]
  );
  text = script;
}
