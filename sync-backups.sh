#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ -f ".env" ]; then
  set -a
  # shellcheck disable=SC1091
  source ".env"
  set +a
fi

STATE_FILE_PATH="${STATE_FILE_PATH:-./casino-state.json}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
REMOTE_BACKUP_TARGET="${REMOTE_BACKUP_TARGET:-}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

TIMESTAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
SNAPSHOT_DIR="${BACKUP_DIR}/snapshots"

mkdir -p "$BACKUP_DIR" "$SNAPSHOT_DIR"

if [ -f "$STATE_FILE_PATH" ]; then
  SNAPSHOT_FILE="${SNAPSHOT_DIR}/casino-state-${TIMESTAMP}.json"
  cp "$STATE_FILE_PATH" "$SNAPSHOT_FILE"
  cp "$STATE_FILE_PATH" "${BACKUP_DIR}/casino-state-latest.json"
  echo "[BACKUP] Snapshot created: $SNAPSHOT_FILE"
else
  echo "[BACKUP] Warning: state file not found at $STATE_FILE_PATH (skipping snapshot)."
fi

if [ -n "$BACKUP_RETENTION_DAYS" ] && [ "$BACKUP_RETENTION_DAYS" -gt 0 ] 2>/dev/null; then
  find "$SNAPSHOT_DIR" -type f -name "casino-state-*.json" -mtime +"$BACKUP_RETENTION_DAYS" -delete
  echo "[BACKUP] Cleaned snapshots older than ${BACKUP_RETENTION_DAYS} days."
fi

if [ -n "$REMOTE_BACKUP_TARGET" ]; then
  if command -v rsync >/dev/null 2>&1; then
    echo "[BACKUP] Syncing $BACKUP_DIR/ to $REMOTE_BACKUP_TARGET ..."
    rsync -az --delete "${BACKUP_DIR}/" "${REMOTE_BACKUP_TARGET%/}/"
    echo "[BACKUP] Remote sync completed."
  else
    echo "[BACKUP] Warning: 'rsync' is not installed; skipping remote sync to $REMOTE_BACKUP_TARGET."
  fi
else
  echo "[BACKUP] REMOTE_BACKUP_TARGET is empty; local backup only."
fi
