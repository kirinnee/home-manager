{ pkgs ? import <nixpkgs> { } }:
{
  pls = pkgs.writeShellScriptBin "setup-rclone-pcloud" ''
    #!/bin/sh

    USAGE=$(cat <<-END
    Use a machine/computer with the follow criteria:
      1. Browser Access
      2. rclone installed
    and run the following command

      rclone authorize "pcloud"

    and paste the content here
    END
    )

    echo "$USAGE"
    read -r "Token: " token

    # write clone directory
    rclone_home="$HOME/.config/rclone"
    mkdir -p "$rclone_home"
    content="[pcloud_remote]\ntype = pcloud\ntoken = $token"
    echo "$content" > "$rclone_home/rclone.conf"
  '';
}
