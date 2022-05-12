#!/bin/sh

# shellcheck disable=SC2154

if [ "$1" = "" ]; then
	gpg_name=$USER
else
	gpg_name=$1
fi

touch ~/.gitconfig
key=$("$gpg" -K --keyid-format long | "$grep" -B 3 -A 1 "$gpg_name" | $grep '\[SCE\?A\?\]' | $grep -v expired | $sed 's#sec \+[^/]\+/\([0-9A-F]\+\).*#\1#')
printf "[commit]\n\tgpgsign = true\n[user]\n\tsigningkey = %s" "$key" >~/.gitconfig
