{ pkgs ? import <nixpkgs> { } }:

let script = builtins.readFile ./backup-folder.sh; in
pkgs.writeShellScriptBin "pcloud-backup" ''
  #!/bin/sh
  set -e

  echo="${pkgs.coreutils}/bin/echo"
  date="${pkgs.coreutils}/bin/date"
  tar="${pkgs.gnutar}/bin/tar"
  pv="${pkgs.pv}/bin/pv"
  du="${pkgs.coreutils}/bin/du"
  cut="${pkgs.coreutils}/bin/cut"
  rclone="${pkgs.rclone}/bin/rclone"

  ${script}
''
