# Configure the whole devbox
# - Generate GPG and SSH key
# - Generate Devbox UUID
# - Set GPG signing key
# - Configure GitHub to use GPG and SSH Key
{ trivialBuilders, nixpkgs ? import <nixpkgs> { }, set-signing-key, register-with-github, setup-keys }:

let name = "setup-devbox-server"; in
let version = "1.0.0"; in
let script = builtins.readFile ./default.sh; in
trivialBuilders.writeShellApplication {
  name = name;
  version = version;
  runtimeShell = "${nixpkgs.bash}/bin/sh";
  runtimeInputs = (
    with nixpkgs;
    [ coreutils setup-keys set-signing-key register-with-github ]
  );
  text = script;
}
