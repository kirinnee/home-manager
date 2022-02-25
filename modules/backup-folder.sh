#!/bin/sh

# shellcheck disable=SC2154
command_type="$1"
target="$2"
pcloud_folder="$3"

[ "$command_type" = "" ] && echo "unknown command: ${command_type}. accepts 'backup' and 'restore'." && exit 1

restore() {
	echo "🔎 Looking for index in target backup folder..."
	rclone lsf "pcloud_remote:Backup/$pcloud_folder/index.index" || (echo "❌ Index not found, aborting..." && exit 1)
	echo ✅ Index found!

	echo 🔎 Checking latest backup status...
	backup_target="$(cat rclone cat "pcloud_remote:Backup/$pcloud_folder/index.index")"
	rclone lsf "pcloud_remote:Backup/$pcloud_folder/$backup_target" || (echo "❌ Index found, but backup not found. Aborting..." && exit 1)
	echo ✅ Backup found!

	cleanup_restore() {
		echo 🗑️ Deleting archive...
		rm "$backup_target" || true
		echo ✅ Completed deleting!
	}

	trap cleanup_restore EXIT

	echo ⬇️ Downloading latest backup...
	rclone copy --progress "pcloud_remote:Backup/$pcloud_folder/$backup_target" "."
	echo ✅ Backup successfully downloaded!

	echo 🔃 Restoring backup...
	pv "$backup_target" | tar -xz
	echo ✅ Backup successfully restored!
}

backup() {
	echo ⏳ Gathering timestamp and filename...
	timestamp="$(TZ='Singapore/Singapore' date '+%Y%b%d_%H%M')"
	name="archive-$timestamp.tar.gz"
	echo ✅ "Timestamp: $timestamp; Filename: $name ;"

	cleanup() {
		echo 🗑️ Deleting archive...
		rm "$name" || true
		echo ✅ Completed deleting!

		echo 🗑️ Deleting index...
		rm index.index || true
		echo ✅ Completed deleting!
	}

	trap cleanup EXIT

	echo 📦 Begin packing...
	tar cf - "$target" | pv -p -s "$(du -sk "$target" | cut -f 1)k" >"$name"
	echo ✅ Done Packing!

	echo 🗂️ Generating index...
	echo "$name" >>index.index
	echo ✅ Done Generating index!

	echo 🚀 Uploading to pCloud using rclone...
	rclone copy --progress "./$name" "pcloud_remote:Backup/$pcloud_folder"
	echo ✅ Uploaded to pCloud!

	echo 🛳️ Uploading index to pCloud using rclone...
	rclone copy --progress "./index.index" "pcloud_remote:Backup/$pcloud_folder"
	echo ✅ Index updated!
}

if [ "$command_type" = "backup" ]; then
	backup
else
	restore
fi
