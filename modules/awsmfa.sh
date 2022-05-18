#!/bin/bash

set -eo pipefail

mode="$1"

USAGE=$(
	cat <<-END
		    Configure AWS CLI to use MFA

		    awsmfa setup <AWS IAM ARN>           : Input AWS ARN
		    awsmfa auth -u <username> -t <token> : Initialize MFA Auth
	END
)

[ "$mode" != "auth" ] && [ "$mode" != "setup" ] && echo "$USAGE" && exit 1

if [ "$mode" = "setup" ]; then
	echo "Enter AWS IAM ARN"
	read -r aws
	printf "%s" "$aws" >~/.awsmfa_arn
	echo "Setup complete!"
	exit 0
fi

shift

while getopts u:t: flag; do
	case "${flag}" in
	u) username=${OPTARG} ;;
	t) token=${OPTARG} ;;
	*) echo "Unknown Flag" && exit 1 ;;
	esac
done

[ -e ~/.awsmfa_arn ] || (echo "Have not been setup" && exit 1)
[ "$username" = "" ] && echo "-u (username) not set" && exit 1
[ "$token" = "" ] && echo "-t (token) not set" && exit 1

aws="$(cat ~/.awsmfa_arn)"

response=$(aws --profile default sts get-session-token --serial-number "arn:aws:iam::$aws:mfa/$username" --token-code "$token" | jq '.')
accessKeyId=$(echo "$response" | jq -r '.Credentials.AccessKeyId')
secretKeyId=$(echo "$response" | jq -r '.Credentials.SecretAccessKey')
sessionToken=$(echo "$response" | jq -r '.Credentials.SessionToken')

aws configure set aws_access_key_id "$accessKeyId" --profile default-mfa
aws configure set aws_secret_access_key "$secretKeyId" --profile default-mfa
aws configure set aws_session_token "$sessionToken" --profile default-mfa
aws configure set region ap-southeast-1 --profile default-mfa

echo "Successfully authenticated with MFA"
