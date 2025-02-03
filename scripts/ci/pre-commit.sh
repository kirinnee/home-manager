#!/usr/bin/env bash
set -eou pipefail

# run precommit
echo "🏃‍➡️ Running Pre-Commit..."
pre-commit run --all -v
echo "✅ Done!"
