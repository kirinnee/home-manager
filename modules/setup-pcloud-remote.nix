{ pkgs ? import <nixpkgs> { } }:
let script = builtins.readFile ./setup-pcloud-remote.sh; in
pkgs.writeShellScriptBin "setup-rclone-pcloud" ''
  #!/bin/sh

  echo="${pkgs.coreutils}/bin/echo"
  cat="${pkgs.coreutils}/bin/cat"
  mkdir="${pkgs.coreutils}/bin/mkdir"

  ${script}
''
