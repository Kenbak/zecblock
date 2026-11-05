#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=server/deploy/lib/indexer-progress-health.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/indexer-progress-health.sh"

# General ops health check: disk, backups, pgBackRest, WAL, Redis,
# PostgreSQL pool, indexer lag, replication lag, replica connectivity,
# and node sync. Complements cipherscan-rust/deploy/check-indexer-health.sh.
#
# Alert dedup/cooldown: only re-alert on a NEW failure signature or after
# the cooldown elapses, and send a single recovery message when all pass.

STATE_DIR="${OPS_HEALTH_STATE_DIR:-/var/lib/cipherscan-ops-health}"
STATE_FILE="${STATE_DIR}/health-alert-state.env"
ALERT_COOLDOWN_SECONDS="${OPS_HEALTH_ALERT_COOLDOWN_SECONDS:-1800}"

DISK_WARN_PCT="${OPS_HEALTH_DISK_WARN_PCT:-90}"
DISK_PATHS="${OPS_HEALTH_DISK_PATHS:-/ /mnt/data}"

PGBACKREST_STANZA="${PGBACKREST_STANZA:-zcash_explorer_mainnet}"
PGBACKREST_MAX_BACKUP_AGE_HOURS="${OPS_HEALTH_PGBACKREST_MAX_BACKUP_AGE_HOURS:-30}"
PGBACKREST_MAX_WAL_AGE_MINUTES="${OPS_HEALTH_PGBACKREST_MAX_WAL_AGE_MINUTES:-30}"

REDIS_HOST="${REDIS_HOST:-127.0.0.1}"
REDIS_PORT="${REDIS_PORT:-6379}"

PG_DATABASE="${PG_DATABASE:-zcash_explorer_mainnet}"
PG_CONN_WARN_PCT="${OPS_HEALTH_PG_CONN_WARN_PCT:-80}"

INDEXER_MAX_LAG="${OPS_HEALTH_INDEXER_MAX_LAG:-3}"
INDEXER_MAX_HEARTBEAT_AGE_SECONDS="${OPS_HEALTH_INDEXER_MAX_HEARTBEAT_AGE_SECONDS:-600}"

REPLICA_HOST="${REPLICA_HOST:-}"
REPLICATION_MAX_LAG_SECONDS="${OPS_HEALTH_REPLICATION_MAX_LAG_SECONDS:-60}"

NODE_RPC_URL="${NODE_RPC_URL:-http://127.0.0.1:8232}"
NODE_COOKIE_FILE="${NODE_COOKIE_FILE:-/root/.cache/zebra/.cookie}"
NODE_MAX_LAG_BLOCKS="${OPS_HEALTH_NODE_MAX_LAG_BLOCKS:-5}"
API_GRPC_STATUS_URL="${API_GRPC_STATUS_URL:-http://127.0.0.1:3001/api/grpc-status}"

TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-}"
TELEGRAM_API_BASE="${TELEGRAM_API_BASE:-https://api.telegram.org}"
HOST_LABEL="$(hostname -f 2>/dev/null || hostname)"

mkdir -p "${STATE_DIR}"

if [[ -z "${TELEGRAM_BOT_TOKEN}" || -z "${TELEGRAM_CHAT_ID}" ]]; then
  echo "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set" >&2
  exit 2
fi

send_telegram() {
  local message="$1"
  curl -fsS -X POST \
    "${TELEGRAM_API_BASE}/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=${message}" \
    --data-urlencode "parse_mode=HTML" \
    --data-urlencode "disable_web_page_preview=true" \
    >/dev/null
}

previous_status="unknown"
previous_fingerprint=""
previous_alert_at=0
# shellcheck disable=SC1090
[[ -f "${STATE_FILE}" ]] && source "${STATE_FILE}"

persist_state() {
  cat > "${STATE_FILE}" <<EOF
previous_status=$1
previous_fingerprint=$2
previous_alert_at=$3
EOF
}

# Track all check names and their pass/fail for the formatted summary
declare -A check_results
failures=()
indexer_failure_codes=()

mark_check() {
  local name="$1"
  local passed="$2"
  check_results["${name}"]="${passed}"
}

# --- Disk space ---
disk_ok=1
for path in ${DISK_PATHS}; do
  if [[ -d "${path}" ]]; then
    usage_pct="$(df -P "${path}" | awk 'NR==2 {gsub("%","",$5); print $5}')"
    if [[ "${usage_pct}" =~ ^[0-9]+$ ]] && (( usage_pct >= DISK_WARN_PCT )); then
      failures+=("Disk ${path} at ${usage_pct}%")
      disk_ok=0
    fi
  fi
done
mark_check "Disk" "${disk_ok}"

# --- pgBackRest backup age ---
pgbackrest_ok=1
if command -v pgbackrest >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
  pgbackrest_json="$(sudo -u postgres pgbackrest --stanza="${PGBACKREST_STANZA}" info --output=json 2>&1 || true)"
  stanza_status_code="$(echo "${pgbackrest_json}" | jq -r '.[0].status.code' 2>/dev/null || echo "")"
  if [[ "${stanza_status_code}" != "0" ]]; then
    failures+=("pgBackRest stanza not ok (code=${stanza_status_code:-unknown})")
    pgbackrest_ok=0
  else
    latest_backup_stop="$(echo "${pgbackrest_json}" | jq -r '.[0].backup[-1].timestamp.stop' 2>/dev/null || echo "")"
    if [[ "${latest_backup_stop}" =~ ^[0-9]+$ ]]; then
      now_epoch="$(date -u +%s)"
      pgbackrest_age_hours=$(( (now_epoch - latest_backup_stop) / 3600 ))
      if (( pgbackrest_age_hours >= PGBACKREST_MAX_BACKUP_AGE_HOURS )); then
        failures+=("pgBackRest backup ${pgbackrest_age_hours}h old (max ${PGBACKREST_MAX_BACKUP_AGE_HOURS}h)")
        pgbackrest_ok=0
      fi
    else
      failures+=("Cannot read pgBackRest backup timestamp")
      pgbackrest_ok=0
    fi
  fi
else
  failures+=("pgbackrest or jq not installed")
  pgbackrest_ok=0
fi
mark_check "Backup" "${pgbackrest_ok}"

# --- Redis ---
redis_ok=1
if command -v redis-cli >/dev/null 2>&1; then
  redis_reply="$(redis-cli -h "${REDIS_HOST}" -p "${REDIS_PORT}" ping 2>&1 || true)"
  if [[ "${redis_reply}" != "PONG" ]]; then
    failures+=("Redis ping failed")
    redis_ok=0
  fi
else
  failures+=("redis-cli not found")
  redis_ok=0
fi
mark_check "Redis" "${redis_ok}"

# --- PostgreSQL connections + WAL archiving + indexer lag ---
pg_ok=1
wal_ok=1
indexer_ok=1
if command -v psql >/dev/null 2>&1; then
  pg_stats="$(sudo -u postgres psql -d "${PG_DATABASE}" -Atc \
    "SELECT (SELECT count(*) FROM pg_stat_activity), (SELECT setting FROM pg_settings WHERE name = 'max_connections')" \
    2>&1 || true)"
  if [[ "${pg_stats}" =~ ^([0-9]+)\|([0-9]+)$ ]]; then
    active="${BASH_REMATCH[1]}"
    max_conn="${BASH_REMATCH[2]}"
    conn_pct=$(( active * 100 / max_conn ))
    if (( conn_pct >= PG_CONN_WARN_PCT )); then
      failures+=("PG connections ${active}/${max_conn} (${conn_pct}%)")
      pg_ok=0
    fi
  else
    failures+=("Cannot read PG connection stats")
    pg_ok=0
  fi

  # --- WAL archiving freshness ---
  # Query returns: archive_mode | failed_count | seconds_since_last_archive | 1_if_last_failure_is_newer_than_last_success
  archiver_stats="$(sudo -u postgres psql -d "${PG_DATABASE}" -Atc \
    "SELECT (SELECT setting FROM pg_settings WHERE name = 'archive_mode'), failed_count, COALESCE(EXTRACT(EPOCH FROM (now() - last_archived_time))::bigint, -1), CASE WHEN last_failed_time > last_archived_time THEN 1 ELSE 0 END FROM pg_stat_archiver" \
    2>&1 || true)"
  if [[ "${archiver_stats}" =~ ^([a-z]+)\|([0-9]+)\|(-?[0-9]+)\|([01])$ ]]; then
    archive_mode="${BASH_REMATCH[1]}"
    archive_failed_count="${BASH_REMATCH[2]}"
    archive_age_seconds="${BASH_REMATCH[3]}"
    archive_failing_now="${BASH_REMATCH[4]}"
    if [[ "${archive_mode}" != "on" && "${archive_mode}" != "always" ]]; then
      failures+=("WAL archive_mode '${archive_mode}' (not on)")
      wal_ok=0
    elif (( archive_age_seconds >= 0 )) && (( archive_age_seconds > PGBACKREST_MAX_WAL_AGE_MINUTES * 60 )); then
      failures+=("Last WAL archive $((archive_age_seconds / 60))m ago (max ${PGBACKREST_MAX_WAL_AGE_MINUTES}m)")
      wal_ok=0
    fi
    if (( archive_failing_now == 1 )) && (( archive_failed_count > 0 )); then
      failures+=("WAL archiver: ${archive_failed_count} failed attempts")
      wal_ok=0
    fi
  else
    failures+=("Cannot read pg_stat_archiver")
    wal_ok=0
  fi

  # --- Indexer lag ---
  lag_stats="$(sudo -u postgres psql -d "${PG_DATABASE}" -Atc \
    "SELECT
       (SELECT value::bigint FROM indexer_state WHERE key = 'last_indexed_height'),
       (SELECT value::bigint FROM indexer_state WHERE key = 'last_seen_rpc_tip'),
       (SELECT value::bigint FROM indexer_state WHERE key = 'last_success_at'),
       (SELECT value::bigint FROM indexer_state WHERE key = 'last_tip_check_at'),
       COALESCE((SELECT value FROM indexer_state WHERE key = 'pending_work_since'), 'none')" \
    2>&1 || true)"
  if [[ "${lag_stats}" =~ ^([0-9]+)\|([0-9]+)\|([0-9]+)\|([0-9]+)\|([0-9]+|none)$ ]]; then
    progress_assessment="$(assess_indexer_progress \
      "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}" \
      "${BASH_REMATCH[4]}" "${BASH_REMATCH[5]}" "$(date -u +%s)" \
      "${INDEXER_MAX_LAG}" "${INDEXER_MAX_HEARTBEAT_AGE_SECONDS}")"
    while IFS='|' read -r code detail; do
      [[ -z "${code}" ]] && continue
      failures+=("${detail}")
      indexer_failure_codes+=("${code}")
      indexer_ok=0
    done <<< "${progress_assessment}"
  else
    failures+=("Cannot read indexer_state")
    indexer_ok=0
  fi
else
  failures+=("psql not found")
  pg_ok=0
  wal_ok=0
  indexer_ok=0
fi
mark_check "PG pool" "${pg_ok}"
mark_check "WAL" "${wal_ok}"
mark_check "Indexer" "${indexer_ok}"

# --- Replication lag (HA check) ---
replication_ok=1
if command -v psql >/dev/null 2>&1; then
  repl_stats="$(sudo -u postgres psql -d "${PG_DATABASE}" -Atc \
    "SELECT count(*), COALESCE(MAX(EXTRACT(EPOCH FROM replay_lag))::bigint, 0) FROM pg_stat_replication" \
    2>&1 || true)"
  if [[ "${repl_stats}" =~ ^([0-9]+)\|([0-9]+)$ ]]; then
    repl_count="${BASH_REMATCH[1]}"
    repl_lag_sec="${BASH_REMATCH[2]}"
    if (( repl_count == 0 )); then
      failures+=("No active replication slots")
      replication_ok=0
    elif (( repl_lag_sec > REPLICATION_MAX_LAG_SECONDS )); then
      failures+=("Replication lag ${repl_lag_sec}s (max ${REPLICATION_MAX_LAG_SECONDS}s)")
      replication_ok=0
    fi
  else
    failures+=("Cannot read pg_stat_replication")
    replication_ok=0
  fi
fi
mark_check "Replication" "${replication_ok}"

# --- Replica connectivity (HA check) ---
replica_ok=1
if [[ -n "${REPLICA_HOST}" ]]; then
  if command -v pg_isready >/dev/null 2>&1; then
    if ! pg_isready -h "${REPLICA_HOST}" -t 5 >/dev/null 2>&1; then
      failures+=("Replica ${REPLICA_HOST} unreachable")
      replica_ok=0
    fi
  else
    failures+=("pg_isready not found")
    replica_ok=0
  fi
else
  replica_ok=1
fi
mark_check "Replica" "${replica_ok}"

# --- Node sync (HA check) ---
node_ok=1
rpc_auth_args=()
if [[ -f "${NODE_COOKIE_FILE}" ]]; then
  rpc_auth_args=(-u "$(cat "${NODE_COOKIE_FILE}")")
fi
if command -v curl >/dev/null 2>&1; then
  node_height="$(curl -sf --max-time 5 "${rpc_auth_args[@]}" -X POST "${NODE_RPC_URL}" \
    -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"1.0","id":"health","method":"getblockcount","params":[]}' 2>/dev/null \
    | jq -r '.result // empty' 2>/dev/null || echo "")"
  if [[ "${node_height}" =~ ^[0-9]+$ ]]; then
    if command -v psql >/dev/null 2>&1; then
      db_tip="$(sudo -u postgres psql -d "${PG_DATABASE}" -Atc \
        "SELECT COALESCE((SELECT value::bigint FROM indexer_state WHERE key = 'last_indexed_height'), 0)" \
        2>&1 || echo "0")"
      if [[ "${db_tip}" =~ ^[0-9]+$ ]]; then
        node_delta=$(( node_height - db_tip ))
        if (( node_delta < 0 )); then node_delta=$(( -node_delta )); fi
        if (( node_delta > NODE_MAX_LAG_BLOCKS )); then
          failures+=("Node sync delta ${node_delta} blocks (node ${node_height}, db ${db_tip})")
          node_ok=0
        fi
      fi
    fi
  else
    failures+=("Node RPC unreachable")
    node_ok=0
  fi
fi
mark_check "Node sync" "${node_ok}"

# --- API real-time bridge ---
realtime_ok=1
if command -v curl >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
  realtime_status="$(curl -fsS --max-time 5 "${API_GRPC_STATUS_URL}" 2>/dev/null || true)"
  realtime_connected="$(printf '%s' "${realtime_status}" | jq -r '.connected // false' 2>/dev/null || echo "false")"
  if [[ "${realtime_connected}" != "true" ]]; then
    failures+=("API gRPC real-time bridge disconnected")
    realtime_ok=0
  fi
else
  failures+=("curl or jq not found for API real-time check")
  realtime_ok=0
fi
mark_check "API realtime" "${realtime_ok}"

timestamp="$(date -u '+%Y-%m-%d %H:%M:%S UTC')"
now="$(date +%s)"

total_checks="${#check_results[@]}"
passing=0
for k in "${!check_results[@]}"; do
  if [[ "${check_results[$k]}" == "1" ]]; then
    (( passing++ )) || true
  fi
done
failing=$(( total_checks - passing ))

build_check_line() {
  local name="$1"
  local passed="${check_results[$name]:-0}"
  if [[ "${passed}" == "1" ]]; then
    echo "✅ ${name}"
  else
    echo "❌ ${name}"
  fi
}

CHECK_NAMES=("Disk" "Backup" "WAL" "Redis" "PG pool" "Indexer" "Replication" "Replica" "Node sync")

if (( ${#failures[@]} == 0 )); then
  if [[ "${previous_status}" == "unhealthy" ]]; then
    check_summary=""
    for name in "${CHECK_NAMES[@]}"; do
      [[ -n "${check_results[${name}]+x}" ]] && check_summary+="$(build_check_line "${name}")  "
    done
    send_telegram "$(cat <<EOF
🟢 <b>CipherScan Recovered</b>

<b>Host:</b> ${HOST_LABEL}
<b>Time:</b> ${timestamp}

All ${total_checks} checks passing
${check_summary}
EOF
)"
  fi
  persist_state "healthy" "" "${now}"
  exit 0
fi

# Clock ages change on every poll; fingerprint their failure categories instead.
# Preserve the existing signatures for all other operational checks.
summary="$(for failure in "${failures[@]}"; do
  [[ "${failure}" == Indexer\ * ]] || printf '%s\n' "${failure}"
done
printf '%s\n' "${indexer_failure_codes[@]}")"
fingerprint="$(printf '%s' "${summary}" | shasum -a 256 | awk '{print $1}')"

should_alert=0
if [[ "${previous_status}" != "unhealthy" ]]; then
  should_alert=1
elif [[ "${previous_fingerprint}" != "${fingerprint}" ]]; then
  should_alert=1
elif (( now - previous_alert_at >= ALERT_COOLDOWN_SECONDS )); then
  should_alert=1
fi

if (( should_alert == 1 )); then
  check_lines=""
  for name in "${CHECK_NAMES[@]}"; do
    [[ -n "${check_results[${name}]+x}" ]] && check_lines+="$(build_check_line "${name}")"$'\n'
  done

  failure_details=""
  for f in "${failures[@]}"; do
    failure_details+="  • ${f}"$'\n'
  done

  send_telegram "$(cat <<EOF
🔴 <b>CipherScan Alert</b>

<b>Host:</b> ${HOST_LABEL}
<b>Time:</b> ${timestamp}

${check_lines}
${failing} of ${total_checks} checks failing:
${failure_details}
EOF
)"
  persist_state "unhealthy" "${fingerprint}" "${now}"
else
  persist_state "unhealthy" "${previous_fingerprint}" "${previous_alert_at}"
fi

exit 1
