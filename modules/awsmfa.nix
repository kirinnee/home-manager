# Generates UUID to identify machine

{ pkgs ? import <nixpkgs> { } }:
let script = builtins.readFile ./awsmfa.sh; in
pkgs.writeShellScriptBin "awsmfa" ''
  #!${pkgs.bash}/bin/bash

  # add coreutils to path
  PATH=$PATH:${pkgs.coreutils}/bin
  PATH=$PATH:${pkgs.jq}/bin
  PATH=$PATH:${pkgs.awscli2}/bin
  ${script}
''
