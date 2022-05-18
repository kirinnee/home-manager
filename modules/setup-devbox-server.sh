#!/bin/sh

# shellcheck disable=SC2154

stty -echo
while true; do
	echo "SSH Passphrase:"
	read -r ssh_pass
	echo "Confirm SSH Passphrase:"
	read -r ssh_verify
	if [ "$ssh_pass" = "$ssh_verify" ]; then
		break
	else
		echo "Passphrase Mismatched!"
	fi
done

while true; do
	echo "GPG Passphrase:"
	read -r gpg_pass
	echo "Confirm GPG Passphrase:"
	read -r gpg_verify
	if [ "$gpg_pass" = "$gpg_verify" ]; then
		break
	else
		echo "Passphrase Mismatched!"
	fi
done
stty echo

gpg_name="$(git config --get user.name)"
gpg_email="$(git config --get user.email)"

variable="b
$ssh_pass
$ssh_pass
$gpg_name
$gpg_email
Devbox Key
$gpg_pass
$gpg_pass
"

printf '%s' "$variable" | $setup_keys

$set_signing_key
$register_with_github
