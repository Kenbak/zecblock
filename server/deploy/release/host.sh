#!/usr/bin/env bash
# One release procedure for every explorer API host.
#
# The deploy workflow streams this file from its verified checkout over SSH,
# so hosts never execute a copy of the script that could have drifted:
#
#   ssh <host> "bash -s -- status" < server/deploy/release/host.sh
#   ssh <host> "bash -s -- deploy <sha>" < server/deploy/release/host.sh
#
# Target settings come from the environment (see targets.json):
#   NETWORK      mainnet | testnet
#   ROLE         serving | passive
#   SERVICE      API systemd unit
#   PORT         API loopback port (serving only)
#   ALSO_RESTART space-separated units restarted after a healthy API (optional)
#   ENFORCE_MIGRATIONS  1 = refuse to restart while schema files are unrecorded
#   CHECKOUT     defaults to /root/cipherscan
set -euo pipefail

CHECKOUT="${CHECKOUT:-/root/cipherscan}"
command="${1:-}"
cd "$CHECKOUT"

log() { printf '[%s] %s\n' "${NETWORK:-?}/${ROLE:-?}" "$*"; }

# Tracked modifications are drift; untracked logs and deploy markers are not.
tracked_changes() { git status --porcelain --untracked-files=no; }

node_bin() {
  # The unit's ExecStart (after drop-ins) is the runtime that actually serves.
  local exec
  exec="$(systemctl show -p ExecStart --value "$SERVICE" 2>/dev/null | sed -n 's/.*path=\([^ ;]*\).*/\1/p' | head -1)"
  if [[ -x "$exec" ]]; then echo "$exec"; else command -v node; fi
}

applied_migrations() {
  # Raw recorded versions; the drift report compares them with the release's
  # files. A passive replica mirrors the primary, so it is not compared.
  if [[ "$ROLE" == passive ]]; then echo 'skipped'; return; fi
  local db
  db="$(sed -n 's/^DB_NAME=//p' server/api/.env | tr -d '"' | head -1)"
  sudo -u postgres psql -qtAX -d "$db" -c \
    "SELECT CASE WHEN to_regclass('public.schema_migrations') IS NULL THEN 'missing-table'
            ELSE (SELECT string_agg(version, ',' ORDER BY version) FROM schema_migrations) END" \
    2>/dev/null || echo 'unreadable'
}

status() {
  local changes
  changes="$(tracked_changes)"
  printf 'head=%s\n' "$(git rev-parse HEAD)"
  printf 'tracked_changes=%s\n' "$(printf '%s' "$changes" | grep -c . || true)"
  if [[ -n "$changes" ]]; then printf '%s\n' "$changes" | sed 's/^/changed: /' | head -40; fi
  printf 'node=%s\n' "$("$(node_bin)" --version)"
  printf 'service=%s active=%s enabled=%s\n' "$SERVICE" \
    "$(systemctl is-active "$SERVICE" || true)" "$(systemctl is-enabled "$SERVICE" || true)"
  printf 'pg_in_recovery=%s\n' "$(sudo -u postgres psql -qtAX -c 'SELECT pg_is_in_recovery()' 2>/dev/null || echo unknown)"
  printf 'applied_migrations=%s\n' "$(applied_migrations)"
}

wait_healthy() {
  local _attempt
  for _attempt in $(seq 1 10); do
    if curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null \
       && curl -sf "http://127.0.0.1:${PORT}/health/deep" >/dev/null; then
      return 0
    fi
    sleep 3
  done
  return 1
}

checkout_sha() {
  local sha="$1"
  git fetch --quiet origin main
  git merge-base --is-ancestor "$sha" origin/main
  git checkout --quiet --detach "$sha"
  # Shared lib modules resolve dependencies from the repository root.
  npm ci --omit=dev --no-audit --no-fund
  (cd server/api && npm ci --omit=dev --no-audit --no-fund)
}

deploy() {
  local new_sha="$1" prev_sha
  [[ "$new_sha" =~ ^[0-9a-f]{40}$ ]] || { log "bad sha $new_sha"; exit 1; }
  if [[ -n "$(tracked_changes)" ]]; then
    log "refusing to deploy: tracked files differ from $(git rev-parse --short HEAD)"
    tracked_changes
    log "reconcile the host first (server/deploy/release/README.md)"
    exit 3
  fi

  prev_sha="$(git rev-parse HEAD)"
  echo "$prev_sha" > .previous-deploy-sha
  log "deploying $new_sha (previous $prev_sha)"
  checkout_sha "$new_sha"

  if [[ "$ROLE" == passive ]]; then
    # Keep the failover checkout current without turning the database
    # standby into a second public API host.
    systemctl disable --now "$SERVICE"
    log "checkout ready at $new_sha; $SERVICE remains disabled"
    return 0
  fi

  if [[ "${ENFORCE_MIGRATIONS:-0}" == 1 ]] \
     && ! "$(node_bin)" server/deploy/release/migrations.js check --network "$NETWORK"; then
    log "unrecorded migrations for $NETWORK; restoring $prev_sha without restarting"
    checkout_sha "$prev_sha"
    exit 4
  fi

  systemctl restart "$SERVICE"
  if wait_healthy; then
    local unit
    for unit in ${ALSO_RESTART:-}; do systemctl restart "$unit" || true; done
    log "healthy at $new_sha"
    return 0
  fi

  log "failed readiness at $new_sha; rolling back to $prev_sha"
  checkout_sha "$prev_sha"
  systemctl restart "$SERVICE"
  if wait_healthy; then
    log "rollback to $prev_sha healthy"
  else
    log "rollback to $prev_sha ALSO unhealthy; manual intervention required"
  fi
  exit 1
}

case "$command" in
  status) status ;;
  deploy) deploy "${2:?deploy needs a commit sha}" ;;
  *) echo "usage: host.sh status | deploy <sha>" >&2; exit 64 ;;
esac
