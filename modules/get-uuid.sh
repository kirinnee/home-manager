#!/bin/sh

file="$HOME"/.homemanager_id

if [ -e "$file" ]; then
	cat "$file"
else
	touch "$file"
	echo "Give this DevBox an ID. Leave empty to generate UUID."
	read -r devbox_id
	if [ "$devbox_id" = "" ]; then
		uuidgen >"$file"
	else
		echo "$devbox_id" >"$file"
	fi
fi
