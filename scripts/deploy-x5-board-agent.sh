#!/usr/bin/env bash
set -euo pipefail

# Deploy the reviewed X5/S100 agent bundle over the operator's existing SSH path.
# Studio Local Bridge remains the preferred transport for the web platform;
# this script is only for updating the board-side files and restarting its
# systemd unit when a shell/SCP path is available. The board-side agent is
# profile-driven: select the family with RDK_X5_PROFILE_NAME (X5 reference
# profiles or the rdk-s100-generic-drive.json contract profile).

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
target=${RDK_X5_SSH_TARGET:?set RDK_X5_SSH_TARGET to an SSH target such as root@board-host}
remote_dir=${RDK_X5_AGENT_DIR:-/opt/rdk-board-agent}
profile_name=${RDK_X5_PROFILE_NAME:-rdk-x5-originbot-real.json}
case "$profile_name" in
  rdk-x5-originbot-real.json|rdk-x5-microduck-leg.json|rdk-s100-generic-drive.json) ;;
  *)
    echo 'RDK_X5_PROFILE_NAME must be rdk-x5-originbot-real.json, rdk-x5-microduck-leg.json, or rdk-s100-generic-drive.json.' >&2
    exit 2
    ;;
esac
profile="$repo_root/profiles/$profile_name"

# Both values are interpolated into fixed remote shell commands below. Keep
# the operator-facing SSH/path grammar narrow so a typo cannot become a shell
# fragment on the board. Paths with spaces are intentionally unsupported;
# choose a conventional absolute deployment directory instead.
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
case "$remote_dir" in
  /*|/*/*) ;;
  *)
    echo 'RDK_X5_AGENT_DIR must be an absolute path.' >&2
    exit 2
    ;;
esac
if [[ "$remote_dir" != "/opt/rdk-board-agent" ]]; then
  echo 'RDK_X5_AGENT_DIR must remain /opt/rdk-board-agent because the reviewed systemd units pin this path.' >&2
  exit 2
fi
case "$remote_dir" in
  *[!A-Za-z0-9._/@+-]*)
    echo 'RDK_X5_AGENT_DIR contains unsupported shell characters.' >&2
    exit 2
    ;;
esac

for file in \
  "$repo_root/services/sim2real-web/board-agent-x5.py" \
  "$repo_root/services/sim2real-web/board_ipc.py" \
  "$repo_root/services/sim2real-web/board-drive-publisher.py" \
  "$repo_root/services/sim2real-web/board-telemetry-node.py" \
  "$repo_root/services/sim2real-web/board-policy-runtime.py" \
  "$repo_root/services/sim2real-web/board-joint-policy-runtime.py" \
  "$repo_root/services/sim2real-web/board-telemetry-uploader.py" \
  "$profile"; do
  test -f "$file" || { echo "missing bundle file: $file" >&2; exit 1; }
done

# Code and service assets live under /opt. Policy artifacts intentionally stay
# in the root-only data directory used by board-agent-x5.py; keeping the two
# trees separate prevents a code deployment from silently changing the model
# trust boundary.
# The systemd units write sampler logs, ROS logs, the policy spool and the
# uploader checkpoint under /var/lib.  Provision those directories here as
# part of the deploy transaction; otherwise a fresh board can start the HTTP
# process but silently lose the telemetry sampler on its first boot.
remote_stage=$(ssh "$target" "umask 077; mkdir -p '$remote_dir' '$remote_dir/profiles' '$remote_dir/telemetry' '/root/rdk-board-agent/policies' '/var/lib/rdk-board-agent/telemetry' '/var/lib/rdk-board-agent/roslogs' '/var/lib/rdk-board-agent/runtime'; chmod 0700 '/root/rdk-board-agent' '/root/rdk-board-agent/policies' '/var/lib/rdk-board-agent' '/var/lib/rdk-board-agent/telemetry' '/var/lib/rdk-board-agent/roslogs' '/var/lib/rdk-board-agent/runtime'; mktemp -d '$remote_dir/.staging.XXXXXX'")
case "$remote_stage" in
  "$remote_dir"/.staging.*) ;;
  *) echo 'remote staging directory was unexpected; refusing to continue' >&2; exit 1 ;;
esac
ssh "$target" "mkdir -p '$remote_stage/profiles'"
cleanup_stage() {
  ssh "$target" "rm -rf '$remote_stage'" >/dev/null 2>&1 || true
}
trap cleanup_stage EXIT
scp \
  "$repo_root/services/sim2real-web/board-agent-x5.py" \
  "$repo_root/services/sim2real-web/board_ipc.py" \
  "$repo_root/services/sim2real-web/board-drive-publisher.py" \
  "$repo_root/services/sim2real-web/board-telemetry-node.py" \
  "$repo_root/services/sim2real-web/board-policy-runtime.py" \
  "$repo_root/services/sim2real-web/board-joint-policy-runtime.py" \
  "$repo_root/services/sim2real-web/board-telemetry-uploader.py" \
  "$target:$remote_stage/"
scp "$profile" "$target:$remote_stage/profiles/$profile_name"

# Stop both consumers, swap the reviewed bundle from a private staging
# directory, and keep a rollback copy until both services report active. This
# prevents a failed upload from leaving agent and telemetry code mixed while a
# long-running process continues to serve the old contract.
ssh "$target" /bin/sh -s -- "$remote_stage" "$profile_name" <<'REMOTE'
set -eu
stage=$1
profile_name=$2
case "$profile_name" in
  rdk-x5-originbot-real.json|rdk-x5-microduck-leg.json|rdk-s100-generic-drive.json) ;;
  *) echo 'unexpected profile name' >&2; exit 1 ;;
esac
root=/opt/rdk-board-agent
backup=$(mktemp -d "$root/.backup.XXXXXX")
files="board-agent-x5.py board_ipc.py board-drive-publisher.py board-telemetry-node.py board-policy-runtime.py board-joint-policy-runtime.py board-telemetry-uploader.py"
agent_was_active=0
uploader_was_active=0
# This command is update-only for the reviewed systemd installation. Refuse
# to copy a bundle onto a board that has not gone through the explicit
# install-x5-board-agent.sh initializer; otherwise a successful SCP could
# leave code present but no service boundary to run or supervise it.
if ! systemctl cat rdk-board-agent.service >/dev/null 2>&1; then
  echo 'rdk-board-agent.service is not installed; run install-x5-board-agent.sh first' >&2
  exit 1
fi
if systemctl is-active --quiet rdk-board-agent.service; then agent_was_active=1; fi
if systemctl is-active --quiet rdk-board-telemetry-uploader.service; then uploader_was_active=1; fi
mkdir -p "$backup/profiles"
for file in $files; do
  if [ -f "$root/$file" ]; then cp -p "$root/$file" "$backup/$file"; fi
done
if [ -f "$root/profiles/$profile_name" ]; then
  cp -p "$root/profiles/$profile_name" "$backup/profiles/$profile_name"
fi
restore_on_failure() {
  status=$?
  if [ "$status" -ne 0 ]; then
    # A later service start (for example, the uploader) can fail after the
    # agent has already loaded the new bundle. Stop any currently running
    # consumers before restoring files; `systemctl start` is idempotent and
    # would otherwise leave a live process executing the failed version while
    # the old files are moved back underneath it.
    if systemctl is-active --quiet rdk-board-telemetry-uploader.service; then
      systemctl stop rdk-board-telemetry-uploader.service || true
    fi
    if systemctl is-active --quiet rdk-board-agent.service; then
      systemctl stop rdk-board-agent.service || true
    fi
    for file in $files; do
      if [ -f "$backup/$file" ]; then
        rm -f "$root/$file"
        mv -f "$backup/$file" "$root/$file"
      else
        # The destination may not have existed before this deployment. Remove
        # a newly installed file so a failed transaction cannot leave a mixed
        # bundle that systemd might load on the next restart.
        rm -f "$root/$file"
      fi
    done
    if [ -f "$backup/profiles/$profile_name" ]; then
      rm -f "$root/profiles/$profile_name"
      mv -f "$backup/profiles/$profile_name" "$root/profiles/$profile_name"
    else
      rm -f "$root/profiles/$profile_name"
    fi
    if [ "$agent_was_active" -eq 1 ]; then systemctl start rdk-board-agent.service || true; fi
    if [ "$uploader_was_active" -eq 1 ]; then systemctl start rdk-board-telemetry-uploader.service || true; fi
  fi
  rm -rf "$stage" "$backup"
  exit "$status"
}
trap restore_on_failure EXIT
if [ "$uploader_was_active" -eq 1 ]; then systemctl stop rdk-board-telemetry-uploader.service; fi
if [ "$agent_was_active" -eq 1 ]; then systemctl stop rdk-board-agent.service; fi
for file in $files; do
  test -s "$stage/$file"
  chmod 0755 "$stage/$file"
  mv -f "$stage/$file" "$root/$file"
done
test -s "$stage/profiles/$profile_name"
mv -f "$stage/profiles/$profile_name" "$root/profiles/$profile_name"
if [ "$agent_was_active" -eq 1 ]; then
  systemctl start rdk-board-agent.service
  systemctl is-active --quiet rdk-board-agent.service
fi
if [ "$uploader_was_active" -eq 1 ]; then
  systemctl start rdk-board-telemetry-uploader.service
  systemctl is-active --quiet rdk-board-telemetry-uploader.service
fi
trap - EXIT
rm -rf "$stage" "$backup"
REMOTE
trap - EXIT
echo "X5 agent updated. Verify /healthz through Studio Station; the agent token stays in the board's root-only environment file."
