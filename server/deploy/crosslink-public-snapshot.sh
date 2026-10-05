#!/usr/bin/env bash
# The legacy exporter tarred live RocksDB and checked heights rather than
# branch hashes. Keep public publication fail-closed until a coherent export
# with current branch evidence replaces it. Existing archives are retained.
echo 'Public Crosslink snapshots unavailable: legacy live-state exporter retired.' >&2
exit 1
