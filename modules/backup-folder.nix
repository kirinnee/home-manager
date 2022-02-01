{ pkgs ? import <nixpkgs> { } }:
pkgs.writeShellScriptBin "pcloud-backup" ''
  #!/bin/sh
  set -e

  target="$1"
  pcloud_folder="$2"

  timestamp="$(TZ='Singapore/Singapore' ${pkgs.coreutils}/bin/date '+%Y%b%d_%H%M')"
  name="archive-$timestamp.tar.gz"

  "${pkgs.gnutar}/bin/tar" -zcvf "$name" "$target"

  "${pkgs.rclone}/bin/rclone" copy "./$name" "pcloud_remote:Backup/$pcloud_folder"

  rm "$name"
''
