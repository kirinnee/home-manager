{ pkgs ? import <nixpkgs> { } }:
pkgs.writeShellScriptBin "pcloud-backup" ''
  #!/bin/sh
  set -e

  target="$1"
  pcloud_folder="$2"


  echo ⏳ Gathering timestamp and filename...
  timestamp="$(TZ='Singapore/Singapore' ${pkgs.coreutils}/bin/date '+%Y%b%d_%H%M')"
  name="archive-$timestamp.tar.gz"
  echo ✅ "Timestamp: $timestamp; Filename: $name ;"


  echo 📦 Begin packing...
  "${pkgs.gnutar}/bin/tar" cf - "$target" | "${pkgs.pv}/bin/pv" -p -s "$(${pkgs.coreutils}/bin/du -sk "$target" | ${pkgs.coreutils}/bin/cut -f 1)k"  > "$name"
  echo ✅ Done Packing!

  cleanup() {
    echo 🗑️ Deleting archive...
    rm "$name"
    echo ✅ Completed deleting!
  }
  trap cleanup EXIT

  echo 🚀 Uploading to pCloud using rclone...
  "${pkgs.rclone}/bin/rclone" copy --progress "./$name" "pcloud_remote:Backup/$pcloud_folder"
  echo ✅ Uploaded to pCloud!


''
