#!/bin/sh

# shellcheck disable=SC2154

USAGE=$(
	cat <<-END
		        Set up the following keys:
		        (s) ssh-key (rsa 4096 bits)
		        (g) gpg-key (rsa 4096 bits)
		        (b) both ssh and gpg keys
		        (ps) print ssh pub key
		        (pg) print gpg pub key
		        (p) print both keys
		        Response: One of (s, g, b, ps, pg, p)
	END
)
echo "$USAGE"
read -r option

# Generate SSH Key
if [ "$option" = "b" ] || [ "$option" = "s" ]; then
	echo "=================="
	echo "SSH Key"
	echo "=================="
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
	stty echo
	echo "Generating SSH RSA key of 4096 bits at $HOME/.ssh/id_rsa"
	$ssh_keygen -b 4096 -t rsa -f "$HOME/.ssh/id_rsa" -q -N "$ssh_pass"
fi

# Generate GPG Key
if [ "$option" = "b" ] || [ "$option" = "g" ]; then
	echo "=================="
	echo "GPG Key"
	echo "=================="
	mkdir -p "$HOME/.ssh"
	cd "$HOME/.ssh" || exit 1

	# Get Real Name
	while true; do
		echo "Real Name:"
		read -r gpg_name
		if [ "$gpg_name" != "" ]; then
			break
		else
			echo "Empty Name!"
		fi
	done

	# Get Email
	while true; do
		echo "Email:"
		read -r gpg_email
		if [ "$gpg_email" != "" ]; then
			break
		else
			echo "Empty Email!"
		fi
	done

	echo "Comment:"
	read -r gpg_comment
	stty -echo
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

	# make sure every line isnt blank TODO
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
		EOF
	)
	# Add Comment if appropriate
	if [ "$gpg_comment" != "" ]; then
		gpg_init=$gpg_init$(
			cat <<-EOF

				        Name-Comment: $gpg_comment
			EOF
		)
	fi

	# Add Passphrase if appropriate
	if [ "$gpg_pass" != "" ]; then
		gpg_init=$gpg_init$(
			cat <<-EOF

				        Passphrase: $gpg_pass
			EOF
		)
	fi

	# Finish up
	gpg_init=$gpg_init$(
		cat <<-EOF

			    %commit
			    %echo done
		EOF
	)

	# Actually generate the key
	echo "$gpg_init" | $gpg --verbose --batch --generate-key
	$gpg --list-secret-keys
fi

if [ "$option" = "b" ] || [ "$option" = "s" ] || [ "$option" = "p" ] || [ "$option" = "ps" ]; then
	echo "SSH Pub Key:"
	cat "$HOME"/.ssh/id_rsa.pub
	echo "============================================================"
fi

if [ "$option" = "b" ] || [ "$option" = "g" ] || [ "$option" = "p" ] || [ "$option" = "pg" ]; then
	echo "GPG Pub Key:"
	$gpg -K --keyid-format long | $grep -B 3 -A 1 "$gpg_name" | $grep '\[SCE\?A\?\]' | $grep -v expired | $sed 's#sec \+[^/]\+/\([0-9A-F]\+\).*#\1#' | $gpg --armour --export
	echo "============================================================"
fi

echo "Script successfully completed."
