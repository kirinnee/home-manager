{ pkgs ? import <nixpkgs> { } }:
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

  target="$1"
  pcloud_folder="$2"


  "$echo" ⏳ Gathering timestamp and filename...
  timestamp="$(TZ='Singapore/Singapore' "$date" '+%Y%b%d_%H%M')"
  name="archive-$timestamp.tar.gz"
  "$echo" ✅ "Timestamp: $timestamp; Filename: $name ;"

  cleanup() {
    "$echo" 🗑️ Deleting archive...
    rm "$name"
    "$echo" ✅ Completed deleting!
  }
  trap cleanup EXIT


  "$echo" 📦 Begin packing...
  "$tar" cf - "$target" | "$pv" -p -s "$("$du" -sk "$target" | "$cut" -f 1)k"  > "$name"
  "$echo" ✅ Done Packing!



  "$echo" 🚀 Uploading to pCloud using rclone...
  "$rclone" copy --progress "./$name" "pcloud_remote:Backup/$pcloud_folder"
  "$echo" ✅ Uploaded to pCloud!


''
