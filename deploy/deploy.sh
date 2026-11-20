#!/bin/bash
# Ship the committed HEAD to the server: build concord-io there (matching its
# glibc), install the app, restart. Run from the repository root.
#
#   deploy/deploy.sh root@<host>
#   SSH_OPTS="-J <jump-host>" deploy/deploy.sh root@<host>
set -euo pipefail
HOST=${1:?usage: deploy/deploy.sh root@<host>}
read -r -a SSH_OPTS <<< "${SSH_OPTS:-}"
REV=$(git rev-parse --short HEAD)
[ -z "$(git status --porcelain)" ] || { echo "commit first: deploys ship HEAD" >&2; exit 1; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git archive --format=tar.gz -o "$tmp/shipwright.tgz" HEAD
scp -q "${SSH_OPTS[@]}" "$tmp/shipwright.tgz" "$HOST:/tmp/shipwright-$REV.tgz"

ssh "${SSH_OPTS[@]}" "$HOST" REV="$REV" bash -s <<'EOF'
set -euo pipefail
src=/root/shipwright-src
rm -rf "$src" && mkdir -p "$src" && tar -xzf "/tmp/shipwright-$REV.tgz" -C "$src"

# concord-io, built here so it links against this host's glibc.
(cd "$src/concord-io" && CARGO_TARGET_DIR=/root/shipwright-target nice -n 10 /root/.cargo/bin/cargo build --release --locked -q 2>&1 | tail -20) \
  || (cd "$src/concord-io" && CARGO_TARGET_DIR=/root/shipwright-target nice -n 10 /root/.cargo/bin/cargo build --release -q)
install -m 0755 /root/shipwright-target/release/concord-io /opt/shipwright/bin/concord-io

# The app: root-owned and world-readable (the worker executes the bundled
# Claude Code binary from node_modules), not writable by the service.
new=/opt/shipwright/app.new
rm -rf "$new" && cp -a "$src" "$new" && rm -rf "$new/concord-io"
(cd "$new" && npm ci --omit=dev --no-audit --no-fund -q)
chmod -R a+rX "$new"
install -m 0755 "$new/deploy/as-worker" /opt/shipwright/libexec/as-worker
install -m 0644 "$new/deploy/shipwright.service" /etc/systemd/system/shipwright.service
systemctl daemon-reload
rm -rf /opt/shipwright/app.old
[ -d /opt/shipwright/app ] && mv /opt/shipwright/app /opt/shipwright/app.old
mv "$new" /opt/shipwright/app
echo "$REV" > /opt/shipwright/app/REVISION

# Restart only what was running: a stopped service stays stopped.
if systemctl is-active --quiet shipwright.service; then
  systemctl restart shipwright.service
  echo "deployed $REV and restarted"
else
  echo "deployed $REV (service is stopped; start it with: systemctl start shipwright)"
fi
EOF
