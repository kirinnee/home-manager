# Register GPG and SSH key with GitHub

{ pkgs ? import <nixpkgs> { } }:
let script = builtins.readFile ./register-with-github.sh; in
let get-uuid = import ./get-uuid.nix { inherit pkgs; }; in
pkgs.writeShellScriptBin "register-with-github" ''
  #!/bin/sh

  # Add CoreUtils
  PATH=$PATH:${pkgs.coreutils}/bin
  # Add Curl
  PATH=$PATH:${pkgs.curl}/bin

  sed=${pkgs.gnused}/bin/sed
  gpg=${pkgs.gnupg}/bin/gpg
  git=${pkgs.git}/bin/git

  get_uuid=${get-uuid}/bin/get-uuid

  ${script}
''
