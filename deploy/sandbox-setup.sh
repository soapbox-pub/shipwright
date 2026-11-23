#!/bin/bash
# What deploy/as-worker's task sandboxes need on the host. Run as root, by
# provision.sh and on every deploy. Idempotent.
set -euo pipefail

command -v bwrap >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -yq bubblewrap

# Each task's checkout, home and tmp, and the cache they share. The worker
# writes, the service reads through the group (the setgid bit keeps it).
# The cache starts empty, not from the old shared home's: every agent before
# the sandboxes could write there, browsers included.
install -d -o shipwright-worker -g shipwright-work -m 2750 \
  /srv/shipwright /srv/shipwright/work /srv/shipwright/homes /srv/shipwright/tmp /srv/shipwright/cache
