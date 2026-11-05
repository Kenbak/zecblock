#!/usr/bin/env bash

# Read-only assessment of the writer's persisted clocks. Output is code|detail.
# A quiet chain must not refresh last_success_at or hide a writer that stops polling.
assess_indexer_progress() {
  local indexed="$1" tip="$2" success="$3" tip_check="$4" pending="$5"
  local now="$6" max_lag="$7" max_age="$8" value lag age progress_at
  if [[ "$pending" == none ]]; then
    pending=0
  elif [[ "$pending" =~ ^0+$ ]]; then
    echo 'pending_clock_invalid|Indexer pending work timestamp is zero'
    return
  fi
  for value in "$indexed" "$tip" "$success" "$tip_check" "$pending" "$now" "$max_lag" "$max_age"; do
    if [[ ! "$value" =~ ^[0-9]{1,10}$ ]]; then
      echo 'invalid_state|Indexer state missing or invalid'
      return
    fi
  done
  # Decimal parsing also rejects overflow-sized or shell expression input above.
  indexed=$((10#$indexed)) tip=$((10#$tip)) success=$((10#$success))
  tip_check=$((10#$tip_check)) pending=$((10#$pending)) now=$((10#$now))
  max_lag=$((10#$max_lag)) max_age=$((10#$max_age))
  lag=$((tip - indexed))
  if (( lag < 0 )); then
    echo "checkpoint_ahead|Indexer height ${indexed} exceeds observed tip ${tip}"
  elif (( lag > max_lag )); then
    echo "lag|Indexer lag ${lag} blocks (tip ${tip})"
  fi
  if (( tip_check == 0 || tip_check > now )); then
    echo 'tip_clock_invalid|Indexer polling heartbeat missing or in the future'
  elif (( now - tip_check > max_age )); then
    echo "tip_heartbeat_stale|Indexer polling heartbeat stale $((now - tip_check))s"
  fi
  if (( success == 0 || success > now )); then
    echo 'success_clock_invalid|Indexer block success timestamp missing or in the future'
  fi
  if (( pending > now )); then
    echo 'pending_clock_invalid|Indexer pending work timestamp is in the future'
  fi
  if (( lag > 0 || pending > 0 )); then
    if (( pending == 0 )); then
      echo 'pending_work_clock_missing|Indexer has pending blocks without a work clock'
    else
      progress_at=$pending
      if (( success > progress_at )); then progress_at=$success; fi
      age=$((now - progress_at))
      if (( age > max_age )); then
        echo "ingest_stalled|Indexer has pending blocks without progress for ${age}s"
      fi
    fi
  fi
}

# The regression harness runs this file directly; production sources the function.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  assess_indexer_progress "$@"
fi
