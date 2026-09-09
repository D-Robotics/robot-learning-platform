#!/usr/bin/env bash
set -euo pipefail

# Deploy the reviewed X5 agent bundle over the operator's existing SSH path.
# Studio Local Bridge remains the preferred transport for the web platform;
# this script is only for updating the board-side files and restarting its
# systemd unit when a shell/SCP path is available.

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
target=${RDK_X5_SSH_TARGET:-root@10.185.136.180}
remote_dir=${RDK_X5_AGENT_DIR:-/opt/rdk-board-agent}
profile="$repo_root/profiles/rdk-x5-originbot-real.json"

for file in \
  "$repo_root/services/sim2real-web/board-agent-x5.py" \
  "$repo_root/services/sim2real-web/board-telemetry-node.py" \
  "$repo_root/services/sim2real-web/board-policy-runtime.py" \
  "$repo_root/services/sim2real-web/board-telemetry-uploader.py" \
  "$profile"; do
  test -f "$file" || { echo "missing bundle file: $file" >&2; exit 1; }
done

ssh "$target" "mkdir -p '$remote_dir' '$remote_dir/profiles' '$remote_dir/telemetry' '$remote_dir/policies'"
scp \
  "$repo_root/services/sim2real-web/board-agent-x5.py" \
  "$repo_root/services/sim2real-web/board-telemetry-node.py" \
  "$repo_root/services/sim2real-web/board-policy-runtime.py" \
  "$repo_root/services/sim2real-web/board-telemetry-uploader.py" \
  "$target:$remote_dir/"
scp "$profile" "$target:$remote_dir/profiles/rdk-x5-originbot-real.json"

ssh "$target" "chmod 0755 '$remote_dir/board-agent-x5.py' '$remote_dir/board-telemetry-node.py' '$remote_dir/board-policy-runtime.py' '$remote_dir/board-telemetry-uploader.py'; systemctl restart rdk-board-agent.service; sleep 2; systemctl is-active rdk-board-agent.service"
echo "X5 agent updated. Verify /healthz through Studio Station; the agent token stays in the board's root-only environment file."
