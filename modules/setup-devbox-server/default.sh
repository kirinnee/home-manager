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

ssh-keygen -b 4096 -t rsa -f "$HOME/.ssh/id_rsa" -q -N "$ssh_pass"
gpg_init=$(
	cat <<-EOF
		%echo Generating GPG Key
		Key-Type: RSA
		Key-Length: 4096
		Subkey-Type: RSA
		Subkey-Length: 4096
		Name-Real: $gpg_name
		Name-Email: $gpg_email
		Expire-Date: 0
		Passphrase: $gpg_pass
		%commit
		%echo done
	EOF
)
echo "$gpg_init" | gpg --verbose --batch --generate-key

set-signing-key
register-with-github
