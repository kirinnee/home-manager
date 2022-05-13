# Configure the whole devbox
# - Generate GPG and SSH key
# - Generate Devbox UUID
# - Set GPG signing key
# - Configure GitHub to use GPG and SSH Key
{ pkgs ? import <nixpkgs> { } }:
let script = builtins.readFile ./setup-devbox-server.sh; in
let setup-keys = import ./setup-keys.nix { inherit pkgs; }; in
let set-signing-key = import ./set-signing-key.nix { inherit pkgs; }; in
let register-with-github = import ./register-with-github.nix { inherit pkgs; }; in
pkgs.writeShellScriptBin "setup-devbox-server" ''
  #!/bin/sh

  PATH=$PATH:${pkgs.coreutils}/bin

  setup_keys=${setup-keys}/bin/setup-keys
  set_signing_key=${set-signing-key}/bin/set-signing-key
  register_with_github=${register-with-github}/bin/register-with-github
  ${script}
''
