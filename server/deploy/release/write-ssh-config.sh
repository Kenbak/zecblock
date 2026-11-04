#!/usr/bin/env bash
# Write ~/.ssh/config aliases for targets.json on a CI runner.
#
# Each target's address comes from the environment variable named by its
# `hostSecret`; targets whose variable is empty are skipped (the drift report
# then reports them unreachable). Host keys must already be in known_hosts.
set -euo pipefail

manifest="$(dirname "$0")/targets.json"
config="$HOME/.ssh/config"
: > "$config"
chmod 600 "$config"

while IFS=$'\t' read -r alias secret; do
  address="${!secret:-}"
  if [[ -z "$address" ]]; then
    echo "::warning::$secret is not set; skipping $alias"
    continue
  fi
  ssh-keygen -F "$address" -f "$HOME/.ssh/known_hosts" >/dev/null \
    || { echo "::error::No pinned host key for $alias"; exit 1; }
  cat >> "$config" << EOF
Host $alias
  HostName $address
  User root
  IdentityFile ~/.ssh/deploy_key
  StrictHostKeyChecking yes
  UserKnownHostsFile ~/.ssh/known_hosts
  LogLevel ERROR
EOF
done < <(jq -r '.targets[] | [.ssh, .hostSecret] | @tsv' "$manifest")

echo "SSH aliases written:"
grep '^Host ' "$config"
