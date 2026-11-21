# Shipwright

An AI agent that lives in the Soapbox community on [Armada](https://armada.buzz).
When someone reports a bug or asks for a feature, it gets Armada changed: an
Opus agent implements it in its own checkout, and Shipwright comes back to the
conversation with a preview link, screenshots (and a video when it helps), and
a pull request on ngit for the maintainers to review.

- **npub:** `npub1sgw99tlq7wgsfza0hd3fs925vrqgu48ajchkhyfzvrhpysl95ztsvj35mg`
- **Runs as:** systemd unit `shipwright` on an Ubuntu 24.04 host (an unprivileged LXC works)
- **Works on:** `nostr://soapbox.pub/relay.ngit.dev/armada`

## How it works

```
Armada community (Concord, E2EE)
        │  gift-wrapped chat over relays
        ▼
  concord-io (Rust)          membership, decrypt, post — JSON lines on stdio
        │
        ▼
  Shipwright (Node)
   ├─ coordinator            Claude Haiku 5.5: reads the channel, replies,
   │                         starts / revises / cancels tasks (tools only, no shell)
   ├─ runner                 up to 3 tasks at once, each:
   │    ├─ checkout          git clone --shared of the Armada mirror, npm ci
   │    ├─ worker            Claude Opus 5.5 (Claude Code via the Agent SDK),
   │    │                    as the unprivileged shipwright-worker user:
   │    │                    implement, npm run test, commit, capture screenshots
   │    ├─ preview           npm run build → named nsite sw-<task> → nsite.run
   │    ├─ media             screenshots/video (webm → mp4) → Blossom
   │    └─ PR                ngit send (revisions: --in-reply-to the first one)
   └─ auth proxy             the only holder of the Claude credential
```

**When it speaks.** Rarely. It reads mentions (`nostr:npub…`, a `p` tag, or its
name), replies to it, slash commands (`/bug`, `/feature`, `/tasks`, published in
its kind-10304 manifest), and every message in watched channels
(`SHIPWRIGHT_WATCH_CHANNELS`). A concrete bug report or feature request that
nobody has claimed starts a task silently; the one message about it is the
reply with the pull request, preview and screenshots. Otherwise it only answers
direct questions, and asks one when a request addressed to it is too vague to
start. Failures and declined tasks are logged, not posted. Anyone in the
community can start work; caps are 20 tasks a day and 5 per person.

**Revisions.** Replying to any of Shipwright's messages about a task (or
naming `#id`) reaches the coordinator, which resumes the same Opus session in
the same checkout. New commits go up as a revision of the same PR, and the
preview at the same address updates.

**Self-management.** On every boot it re-asserts its kind 0, relay list
(10002), Blossom list (10063) and bot command manifest (10304), uploads its
avatar if `assets/avatar.png` changed, follows the community's rekeys and
refoundings (membership is saved in `state/concord/membership.json`), and
introduces itself once per community. Checkouts of tasks finished more than a
week ago are deleted.

## Security model

Anyone in the community can steer an Opus agent with a shell. So:

- **The worker holds nothing worth stealing.** Agents run as
  `shipwright-worker`, which can't read `/var/lib/shipwright/secrets` (the
  nsec and the Claude token). Its environment is rebuilt from scratch by
  `deploy/as-worker`.
- **The Claude credential never reaches a worker.** The CLI talks to a
  loopback proxy (`src/authproxy.ts`) with a random per-task token, valid only
  while that task runs; the proxy swaps in the real one.
- **No LAN.** nftables (`deploy/shipwright.nft`) rejects the worker's traffic
  to private ranges, except DNS. It still has the internet, for npm.
- **Workers can't publish.** Signing (PRs, nsites, Blossom) happens in the
  service, from files the worker left. Artifact paths outside `.shipwright/`
  are refused.
- **The service never reads a checkout as itself** (`src/handoff.ts`). A
  checkout can hold symlinks to the secrets or a `.git/config` that runs
  commands. So the worker's own `tar` packs what's published, and the
  service unpacks it into a private directory, keeping only regular files.
  The branch arrives as a git bundle, and git and ffmpeg run as the worker.
  The service has no `safe.directory`, so git won't run in a worker's repo
  for it even by mistake.
- **The coordinator has no built-in tools**, only reply/react/start/revise/
  cancel, so an injection in chat can at worst say something or queue a
  task, which the caps bound.

Every PR still needs a maintainer to review and merge it.

## Operating it

```sh
journalctl -u shipwright -f                 # what it's doing
systemctl restart shipwright

# tasks, from the CLI
sudo -u shipwright -H bash -c 'set -a; . /etc/shipwright/env; cd /opt/shipwright/app && node src/cli.ts tasks'
sudo -u shipwright -H bash -c 'set -a; . /etc/shipwright/env; cd /opt/shipwright/app && node src/cli.ts show <id>'
```

Files on the server:

| Path | What |
| --- | --- |
| `/var/lib/shipwright/secrets/nsec` | Shipwright's key |
| `/var/lib/shipwright/secrets/claude-token` | `claude setup-token` output (a Claude subscription token, valid for a year) |
| `/etc/shipwright/env` | overrides for anything in `src/config.ts` |
| `/var/lib/shipwright/state/` | tasks, chat memory, Concord membership |
| `/var/lib/shipwright/repos/armada` | mirror of Armada; `repos/publish/<id>` are the PR worktrees |
| `/srv/shipwright/work/<id>` | each task's checkout (owned by the worker) |

To rotate the Claude token, run `claude setup-token` anywhere and write the
result to the token file (`install -o shipwright -g shipwright -m 600`); it is
read per request, so no restart is needed.

## Developing

```sh
npm install
npm run check                    # tsc (strip-only TypeScript; Node runs src/ directly)
cd concord-io && cargo build --release
deploy/deploy.sh root@<host>     # ships HEAD: builds concord-io on the server, installs, restarts
deploy/provision.sh              # a fresh host, from scratch (see its header)
```

`concord-io` builds on
[armada-discord-bridge](https://gitworkshop.dev/soapbox.pub/relay.ngit.dev/armada-discord-bridge)'s
`concord` and `bridge` crates, pinned by commit in `concord-io/Cargo.toml`.
Bump that pin when Concord changes.

### Gateway notes

Previews use nsite.run. nsite.lol truncates any blob it fetched from
`blossom.ditto.pub` (it keeps the brotli `Content-Length` while serving the
decompressed body) and caches the result by hash, so Armada builds there,
Soapbox's own `armada` nsite included, render blank. Previews are uploaded only
to servers that send plain bytes (`nostr.download`, `blossom.primal.net`).

## License

[AGPL-3.0-only](LICENSE). `concord-io` builds on armada-discord-bridge's
AGPL-licensed crates.
