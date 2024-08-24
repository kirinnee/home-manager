#!/bin/sh

# shellcheck disable=SC2154

USAGE=$(
  cat <<-END
		  Use a machine/computer with the follow criteria:
		    1. Browser Access
		    2. rclone installed
		  and run the following command

		    rclone authorize "pcloud"

		  and paste the content here
	END
)

echo "$USAGE"
echo "Token: "
read -r token

# write clone directory
rclone_home="$HOME/.config/rclone"
mkdir -p "$rclone_home"
echo "[pcloud_remote]" >"$rclone_home/rclone.conf"
echo "type = pcloud" >>"$rclone_home/rclone.conf"
echo "token = $token" >>"$rclone_home/rclone.conf"
