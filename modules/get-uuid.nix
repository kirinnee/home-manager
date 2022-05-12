# Generates UUID to identify machine

{ pkgs ? import <nixpkgs> { } }:
let script = builtins.readFile ./get-uuid.sh; in
pkgs.writeShellScriptBin "get-uuid" ''
  #!/bin/sh

  # add coreutils to path
  PATH=$PATH:${pkgs.coreutils}/bin
  # add util-linux to path
  PATH=$PATH:${pkgs.util-linux}/bin

  ${script}
''
