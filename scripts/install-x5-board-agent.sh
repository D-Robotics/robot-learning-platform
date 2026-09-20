#!/usr/bin/env bash
set -euo pipefail

# Install the reviewed systemd and root-only state layout for a fresh RDK X5
# board.  This is intentionally separate from deploy-x5-board-agent.sh:
# deploy-x5-board-agent.sh remains an update-only code transaction, while this
# script is an explicit first-boot initializer.
#
# By default this script does not start, stop, restart, or enable a service.
# Existing unit files and environment files are preserved.  Use --force only
# after reviewing a unit change, and use --enable explicitly after the code
# bundle has been deployed and the environment has been reviewed.

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
force=0
enable=0

usage() {
  cat <<'EOF'
Usage: RDK_X5_SSH_TARGET=root@board-host ./scripts/install-x5-board-agent.sh [options]

Install the X5 board-agent systemd units, root-only state directories, and
non-destructive environment-file skeletons.  The default action never starts
or restarts a service and never replaces an existing unit or environment file.

Options:
  --force   replace an existing unit file after reviewing the local unit
  --enable  enable and start rdk-board-agent.service (requires deployed code)
  --help    show this help

After this script, deploy code with deploy-x5-board-agent.sh.  Configure
telemetry.env before explicitly enabling the telemetry uploader.
EOF
}

while (($# > 0)); do
  case "$1" in
    --force) force=1 ;;
    --enable) enable=1 ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

target=${RDK_X5_SSH_TARGET:-}
if [[ -z "$target" ]]; then
  echo 'set RDK_X5_SSH_TARGET to an SSH target such as root@board-host' >&2
  exit 2
fi

# The target is interpolated only as an argv passed to ssh/scp.  Keep the
# operator-facing grammar narrow anyway so a typo cannot become a shell
# fragment in a remote command or an unexpected scp destination.
case "$target" in
  ''|*[!A-Za-z0-9_.@:-]*|*@*@*)
    echo 'RDK_X5_SSH_TARGET must be a simple user@host SSH target.' >&2
    exit 2
    ;;
esac
case "$target" in
  *@*) ;;
  *)
    echo 'RDK_X5_SSH_TARGET must include user@host.' >&2
    exit 2
    ;;
esac
ssh_user=${target%%@*}
ssh_host=${target#*@}
if [[ -z "$ssh_user" || -z "$ssh_host" ]]; then
  echo 'RDK_X5_SSH_TARGET must include non-empty user and host.' >&2
  exit 2
fi

agent_unit="$repo_root/services/sim2real-web/rdk-board-agent.service"
uploader_unit="$repo_root/services/sim2real-web/rdk-board-telemetry-uploader.service"
for file in "$agent_unit" "$uploader_unit"; do
  test -s "$file" || { echo "missing unit file: $file" >&2; exit 1; }
done

# Keep the temporary directory outside the deployment tree.  The generated
# path is checked before it is used as an scp destination and is subsequently
# passed as an argv to the remote shell, never concatenated with user input.
remote_stage=$(ssh "$target" 'umask 077; mktemp -d /tmp/rdk-board-agent-install.XXXXXX')
case "$remote_stage" in
  /tmp/rdk-board-agent-install.*) ;;
  *)
    echo 'remote staging directory was unexpected; refusing to continue' >&2
    exit 1
    ;;
esac
cleanup_stage() {
  ssh "$target" /bin/sh -s -- "$remote_stage" <<'REMOTE_CLEANUP' >/dev/null 2>&1 || true
set -eu
stage=$1
case "$stage" in
  /tmp/rdk-board-agent-install.*) rm -rf -- "$stage" ;;
esac
REMOTE_CLEANUP
}
trap cleanup_stage EXIT

scp "$agent_unit" "$uploader_unit" "$target:$remote_stage/"

# The remote transaction is deliberately idempotent and non-destructive:
# directories are tightened, missing env files receive safe loopback-only
# skeletons, and existing units are left untouched unless --force is set.
ssh "$target" /bin/sh -s -- "$remote_stage" "$force" "$enable" <<'REMOTE_INSTALL'
set -eu
stage=$1
force=$2
enable=$3

test -d "$stage"
test -s "$stage/rdk-board-agent.service"
test -s "$stage/rdk-board-telemetry-uploader.service"

install -d -o root -g root -m 0755 /opt/rdk-board-agent /opt/rdk-board-agent/profiles
install -d -o root -g root -m 0700 \
  /root/rdk-board-agent /root/rdk-board-agent/policies \
  /var/lib/rdk-board-agent /var/lib/rdk-board-agent/telemetry \
  /var/lib/rdk-board-agent/roslogs /var/lib/rdk-board-agent/runtime \
  /etc/rdk-board-agent

write_env_if_missing() {
  file=$1
  kind=$2
  if [ -L "$file" ]; then
    echo "refusing symlink environment file: $file" >&2
    return 1
  fi
  if [ -e "$file" ]; then
    if [ ! -f "$file" ]; then
      echo "environment path is not a regular file: $file" >&2
      return 1
    fi
    chown root:root "$file"
    chmod 0600 "$file"
    return 0
  fi
  umask 077
  case "$kind" in
    agent)
      cat >"$file" <<'EOF_AGENT'
# Safe first-boot defaults. Keep the bind host loopback while the token is empty.
RDK_SIM2REAL_BOARD_AGENT_BIND_HOST=127.0.0.1
RDK_SIM2REAL_BOARD_AGENT_PORT=19100
RDK_SIM2REAL_BOARD_AGENT_TOKEN=
RDK_SIM2REAL_BOARD_AGENT_ENABLE_DRIVE=0
RDK_SIM2REAL_BOARD_AGENT_ENABLE_POLICY=0
RDK_BOARD_RUNTIME_DIR=/var/lib/rdk-board-agent/runtime
RDK_SIM2REAL_ADAPTER_CONFIG=/opt/rdk-board-agent/profiles/rdk-x5-originbot-real.json
EOF_AGENT
      ;;
    telemetry)
      cat >"$file" <<'EOF_TELEMETRY'
# Configure these values before enabling rdk-board-telemetry-uploader.service.
# RDK_SIM2REAL_TELEMETRY_URL=
# RDK_SIM2REAL_TELEMETRY_ATTESTATION_TOKEN=
# RDK_SIM2REAL_RUN_ID=
# RDK_SIM2REAL_DEVICE_ID=
# RDK_BOARD_TELEMETRY_SPOOL=/var/lib/rdk-board-agent/telemetry/policy.jsonl
EOF_TELEMETRY
      ;;
    *)
      echo "unknown environment skeleton: $kind" >&2
      return 1
      ;;
  esac
  chown root:root "$file"
  chmod 0600 "$file"
}

write_env_if_missing /etc/rdk-board-agent/agent.env agent
write_env_if_missing /etc/rdk-board-agent/telemetry.env telemetry

install_unit_if_allowed() {
  source=$1
  destination=$2
  if [ -L "$destination" ]; then
    echo "refusing symlink systemd unit: $destination" >&2
    return 1
  fi
  if [ -e "$destination" ]; then
    if [ ! -f "$destination" ]; then
      echo "systemd unit path is not a regular file: $destination" >&2
      return 1
    fi
    if [ "$force" -ne 1 ]; then
      echo "preserving existing unit (use --force after review): $destination"
      return 0
    fi
  fi
  install -o root -g root -m 0644 "$source" "$destination"
}

install_unit_if_allowed "$stage/rdk-board-agent.service" /etc/systemd/system/rdk-board-agent.service
install_unit_if_allowed "$stage/rdk-board-telemetry-uploader.service" /etc/systemd/system/rdk-board-telemetry-uploader.service
systemctl daemon-reload

if [ "$enable" -eq 1 ]; then
  if [ ! -s /opt/rdk-board-agent/board-agent-x5.py ]; then
    echo 'cannot --enable rdk-board-agent.service before deploying board-agent-x5.py' >&2
    exit 1
  fi
  # This is the only start path and is reachable only through the explicit
  # --enable flag.  The installer never restarts an already running service.
  systemctl enable --now rdk-board-agent.service
fi

echo 'X5 systemd units and root-only state layout are ready.'
if [ "$enable" -ne 1 ]; then
  echo 'No service was started. Deploy code, review agent.env, then explicitly enable the agent.'
fi
REMOTE_INSTALL

trap - EXIT
cleanup_stage
echo 'X5 board-agent initialization complete. Existing units/env files were preserved unless --force was supplied.'
