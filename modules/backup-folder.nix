{ pkgs ? import <nixpkgs> { } }:

let script = builtins.readFile ./backup-folder.sh; in
pkgs.writeShellScriptBin "pcloud-backup" ''
  #!/bin/sh
  set -e

  PATH="${pkgs.coreutils}/bin:${pkgs.gnutar}/bin:${pkgs.pv}/bin:${pkgs.rclone}/bin:$PATH"

  ${script}
''
