// Before any agent runs: prove the task sandbox (deploy/as-worker) holds.
// If bubblewrap is missing or a mount came out wrong, agents would have the
// run of the system, so the service refuses to start instead.
import { config } from "./config.ts";
import { log } from "./log.ts";
import { removeWorkerFiles, runAsWorker } from "./proc.ts";

const ID = "selftest";

/** Each check prints its name if it fails. */
const CHECKS = String.raw`
fail() { echo "$1"; }
here=$(pwd)
[ "$(ls /srv/shipwright/work)" = "${ID}" ] || fail "other checkouts are visible"
[ "$(echo $(ls /srv/shipwright))" = "cache work" ] || fail "other tasks' homes or tmp are visible"
[ ! -e /var/lib/shipwright/secrets ] || fail "the service's secrets are visible"
[ ! -e /var/lib/shipwright/state ] || fail "the service's state is visible"
[ -z "$(ls -A /etc/shipwright)" ] || fail "/etc/shipwright is visible"
[ -e /var/lib/shipwright/repos/armada/.git/objects ] || fail "the mirror is missing"
touch "$here/probe" 2>/dev/null && rm "$here/probe" || fail "the checkout is not writable"
touch "$HOME/probe" 2>/dev/null && rm "$HOME/probe" || fail "home is not writable"
touch /tmp/probe 2>/dev/null && rm /tmp/probe || fail "/tmp is not writable"
touch /srv/shipwright/cache/probe 2>/dev/null && fail "the shared cache is writable"
touch /usr/probe 2>/dev/null && fail "/usr is writable"
touch /var/lib/shipwright/repos/armada/.git/probe 2>/dev/null && fail "the mirror is writable"
n=$(ls -d /proc/[0-9]* | wc -l)
[ "$n" -le 6 ] || fail "other processes are visible ($n)"
for p in /srv/shipwright/cache /usr /var/lib/shipwright/repos/armada/.git; do
  unshare -rm sh -c "mount -o remount,bind,rw $p && touch $p/probe" 2>/dev/null && fail "a nested namespace can write $p"
done
unshare -rm sh -c "umount -l /srv/shipwright/work/${ID} && ls /srv/shipwright/work/${ID}/.. | grep -qv ${ID}" 2>/dev/null && fail "a nested namespace can see other checkouts"
echo done
`;

export async function assertSandbox(): Promise<void> {
  if (config.asWorker.length === 0) {
    log.warn("no worker user configured: agents run unsandboxed (local development only)");
    return;
  }
  try {
    const res = await runAsWorker(ID, "sh", ["-c", CHECKS], { check: false, timeoutMs: 60_000 });
    const out = res.stdout.trim().split("\n").filter(Boolean);
    if (res.code !== 0 || out.at(-1) !== "done" || out.length > 1) {
      throw new Error(`the task sandbox is broken: ${[...out.filter((l) => l !== "done"), res.stderr.trim()].filter(Boolean).join("; ") || `exit ${res.code}`}`);
    }
    log.info("task sandbox checked");
  } finally {
    await removeWorkerFiles(ID, `${config.workDir}/${ID}`).catch(() => {});
  }
}
