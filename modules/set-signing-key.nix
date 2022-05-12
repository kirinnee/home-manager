# Set the Git Signing GPG key

{ pkgs ? import <nixpkgs> { } }:
let script = builtins.readFile ./set-signing-key.sh; in
pkgs.writeShellScriptBin "set-signing-key" ''
  #!/bin/sh

  # Linking nix packages
  PATH=$PATH:${pkgs.coreutils}/bin
  gpg=${pkgs.gnupg}/bin/gpg
  grep=${pkgs.gnugrep}/bin/grep
  sed=${pkgs.gnused}/bin/sed

  ${script}


''
