# Setup SSH and PGP keys
{ pkgs ? import <nixpkgs> { } }:
let script = builtins.readFile ./setup-keys.sh; in
pkgs.writeShellScriptBin "setup-keys" ''
  #!/bin/sh

  # Linking nix packages
  PATH=$PATH:${pkgs.coreutils}/bin
  ssh_keygen=${pkgs.openssh}/bin/ssh-keygen
  gpg=${pkgs.gnupg}/bin/gpg
  grep=${pkgs.gnugrep}/bin/grep
  sed=${pkgs.gnused}/bin/sed

  ${script}


''
