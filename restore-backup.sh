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
SOURCE_BACKUP="${1:-${BACKUP_DIR}/casino-state-latest.json}"

if [ ! -f "$SOURCE_BACKUP" ]; then
  echo "[RESTORE] Error: backup file not found at '$SOURCE_BACKUP'" >&2
  echo "Usage: bash ./restore-backup.sh [path/to/backup.json]" >&2
  exit 1
fi

node -e '
  const fs = require("fs");
  const raw = fs.readFileSync(process.argv[1], "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid state JSON structure");
  }
' "$SOURCE_BACKUP"

mkdir -p "$(dirname "$STATE_FILE_PATH")"

if [ -f "$STATE_FILE_PATH" ]; then
  TIMESTAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
  PRE_RESTORE_COPY="${BACKUP_DIR}/snapshots/pre-restore-${TIMESTAMP}.json"
  mkdir -p "$(dirname "$PRE_RESTORE_COPY")"
  cp "$STATE_FILE_PATH" "$PRE_RESTORE_COPY"
  echo "[RESTORE] Saved current state snapshot to: $PRE_RESTORE_COPY"
fi

TMP_TARGET="${STATE_FILE_PATH}.restore.tmp.$$"
cp "$SOURCE_BACKUP" "$TMP_TARGET"
mv -f "$TMP_TARGET" "$STATE_FILE_PATH"

echo "[RESTORE] Successfully restored '$STATE_FILE_PATH' from '$SOURCE_BACKUP'."
