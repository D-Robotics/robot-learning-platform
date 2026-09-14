#!/usr/bin/env bash
set -euo pipefail

storage_dir="${RDK_SIM2REAL_STORAGE_DIR:-/opt/sim2real-web/data}"
backup_root="${RDK_SIM2REAL_BACKUP_DIR:-/var/backups/rdk-sim2real}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
snapshot="${backup_root}/${stamp}"
mkdir -p "${backup_root}"
chmod 700 "${backup_root}"

restart_needed=0
cleanup() {
  if [[ "${restart_needed}" == 1 ]]; then
    systemctl start sim2real-web.service || true
  fi
}
trap cleanup EXIT

# The backup tool refuses a live writer by default. Stop only the standalone
# writer for a short maintenance window, then verify the immutable snapshot
# before bringing traffic back.
if systemctl is-active --quiet sim2real-web.service; then
  systemctl stop sim2real-web.service
  restart_needed=1
fi
node /opt/sim2real-web/current/dist-server/scripts/sim2real-storage-backup.mjs \
  backup --storage-dir "${storage_dir}" --output "${snapshot}"
node /opt/sim2real-web/current/dist-server/scripts/sim2real-storage-backup.mjs \
  verify --snapshot "${snapshot}"

# Keep two weeks of verified snapshots; never remove the newest one.
find "${backup_root}" -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf -- {} +
echo "[sim2real-backup] verified snapshot=${snapshot}"
