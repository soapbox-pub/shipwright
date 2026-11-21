#!/bin/bash
# Provision a fresh Ubuntu 24.04 host (an unprivileged Proxmox LXC with
# nesting=1) for Shipwright. Idempotent: safe to re-run.
#
#   scp -r deploy root@<host>:/root/ && ssh root@<host> bash /root/deploy/provision.sh
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

NODE_VERSION=22.23.1 # Armada's .nvmrc: workers build Armada with exactly this

apt-get update -q
apt-get -yq upgrade
apt-get install -yq build-essential pkg-config git curl ca-certificates jq ffmpeg \
  unattended-upgrades sudo xz-utils unzip nftables

# ── Node, verified against nodejs.org's published checksums ─────────────────
if [ "$(node --version 2>/dev/null)" != "v$NODE_VERSION" ]; then
  tmp=$(mktemp -d)
  tarball="node-v$NODE_VERSION-linux-x64.tar.xz"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$tarball" -o "$tmp/$tarball"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  (cd "$tmp" && grep " $tarball\$" SHASUMS256.txt | sha256sum -c -)
  tar -xJf "$tmp/$tarball" -C /usr/local --strip-components=1 --no-same-owner
  rm -rf "$tmp"
fi

# ── ngit (and git-remote-nostr), hash-pinned by its installer ──────────────
if ! command -v ngit >/dev/null; then
  bash /root/deploy/ngit-install.sh --standalone --install-dir /usr/local/bin
fi

# ── Rust, for building concord-io (root only: workers don't get it) ────────
if [ ! -x /root/.cargo/bin/cargo ]; then
  curl -fsSL https://sh.rustup.rs -o /tmp/rustup.sh
  sh /tmp/rustup.sh -y --profile minimal --default-toolchain stable
fi

# ── Users ──────────────────────────────────────────────────────────────────
# shipwright        runs the service; holds the nsec and the Claude token.
# shipwright-worker runs the Opus agents; holds nothing worth stealing.
getent group shipwright-work >/dev/null || groupadd --system shipwright-work
id shipwright >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/shipwright --shell /bin/bash shipwright
id shipwright-worker >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/shipwright-worker --shell /bin/bash -g shipwright-work shipwright-worker
usermod -aG shipwright-work shipwright

# The service home is traversable (workers clone the Armada mirror from it)
# but its secrets are not.
chmod 0751 /var/lib/shipwright
install -d -o shipwright -g shipwright -m 0700 /var/lib/shipwright/secrets /var/lib/shipwright/state
install -d -o shipwright -g shipwright -m 0755 /var/lib/shipwright/repos
chmod 0750 /var/lib/shipwright-worker
# Task checkouts: the worker writes, the service (via the group) reads.
install -d -o shipwright-worker -g shipwright-work -m 2750 /srv/shipwright /srv/shipwright/work

install -d -o root -g shipwright -m 0750 /etc/shipwright
touch /etc/shipwright/env
chown root:shipwright /etc/shipwright/env && chmod 0640 /etc/shipwright/env

install -d -m 0755 /opt/shipwright /opt/shipwright/bin /opt/shipwright/libexec
install -m 0755 /root/deploy/as-worker /opt/shipwright/libexec/as-worker

cat > /etc/sudoers.d/shipwright <<'EOF'
# The service starts agents and their tooling as the unprivileged worker,
# always through as-worker, which resets the environment.
shipwright ALL=(shipwright-worker) NOPASSWD: /opt/shipwright/libexec/as-worker
EOF
chmod 0440 /etc/sudoers.d/shipwright
visudo -cf /etc/sudoers.d/shipwright

# No safe.directory for the service: git's ownership check is what stops it
# running a worker-owned repository's config (core.fsmonitor and friends).
# It only runs git in its own repositories; worker checkouts reach it as bundles.
sudo -u shipwright git config --global --unset-all safe.directory || true
sudo -u shipwright git config --global user.name Shipwright
sudo -u shipwright git config --global user.email shipwright@nostr.invalid
sudo -u shipwright-worker git config --global user.name Shipwright
sudo -u shipwright-worker git config --global user.email shipwright@nostr.invalid
sudo -u shipwright-worker git config --global --replace-all safe.directory '*'

# ── Chromium's system libraries, for Playwright screenshots and video ──────
npx -y playwright@1 install-deps chromium

# ── Keep the worker off the LAN ─────────────────────────────────────────────
# An agent steered by a prompt injection has a shell; it should reach npm and
# the internet, not every other box in the homelab.
install -m 0644 /root/deploy/shipwright.nft /etc/nftables.conf
systemctl enable --now nftables
nft -f /etc/nftables.conf

# ── Service ────────────────────────────────────────────────────────────────
install -m 0644 /root/deploy/shipwright.service /etc/systemd/system/shipwright.service
systemctl daemon-reload
systemctl enable shipwright.service

echo "provisioned"
