//! concord-io: one identity's membership in one Concord community, spoken as
//! JSON lines so the coordinator (Node) never has to implement Concord.
//!
//! stdout carries events, one JSON object per line:
//!   {"type":"ready", "self", "community":{...}, "channels":[...]}
//!   {"type":"channels", "channels":[...]}            the fold changed
//!   {"type":"message", "channel", "channel_name", "id", "pubkey", "kind",
//!    "content", "tags", "ms", "moderator"}             a post that stands
//!   {"type":"result", "id", "ok", ...}                 a command finished
//!   {"type":"excluded"}                                a Refounding left us out
//!
//! stdin takes commands, one JSON object per line, each with a caller `id`:
//!   {"id", "op":"send", "channel", "kind"?, "content", "tags"?}
//!   {"id", "op":"typing", "channel"}
//!   {"id", "op":"history", "channel", "limit"?, "since_secs"?}
//!   {"id", "op":"channels"}
//!
//! Logs go to stderr: stdout is the protocol, and one stray line would be a
//! parse error on the other end.
//!
//! Env: CONCORD_IO_KEY_FILE (nsec or hex; a file so the key is never in argv
//! or the environment), CONCORD_IO_STATE_DIR, CONCORD_IO_INVITE (needed only
//! until the first successful join; afterwards the stored membership is used,
//! so a revoked invite does not evict us — only a Refounding can).

use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, bail};
use bridge::client::{ConcordClient, OpenedChat, SendChat, now_ms, resolve_invite};
use bridge::community::{Attachment, CommunityRuntime};
use bridge::key_intake::{KeyIntake, intake_access_keys, intake_base_rotations, intake_direct_invite_keys};
use bridge::relays::{Hub, RelayLike, Relays};
use concord::community::{ChannelView, Membership};
use concord::invite::{invite_delivery_relays, parse_invite_link, stock_relays};
use concord::judge::Verdict;
use concord::kinds;
use nostr::prelude::*;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::AsyncBufReadExt;

/// The chat kinds worth a coordinator's attention. Typing, voice presence and
/// the like are moment-to-moment noise.
const FORWARDED: [u16; 5] = [kinds::MESSAGE, kinds::COMMENT, kinds::REACTION, kinds::EDIT, kinds::DELETE];

/// How often the fold is re-read for new channels and the membership saved.
const RESCAN: Duration = Duration::from_secs(20);

static STDOUT: Mutex<()> = Mutex::new(());

fn emit(v: Value) {
    let _guard = STDOUT.lock().unwrap_or_else(|e| e.into_inner());
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

fn env(k: &str) -> Option<String> {
    std::env::var(k).ok().map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
}

fn read_keys(path: &Path) -> anyhow::Result<Keys> {
    let raw = std::fs::read_to_string(path).with_context(|| format!("reading key file {}", path.display()))?;
    let value = raw.trim();
    let sk = if value.starts_with("nsec1") { SecretKey::from_bech32(value)? } else { SecretKey::from_hex(value)? };
    Ok(Keys::new(sk))
}

/// Write-then-rename: a crash mid-write must never leave a truncated
/// membership, which would mean re-joining from an invite that may be gone.
fn save_json(path: &Path, v: &impl serde::Serialize) -> anyhow::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(v)?)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[derive(Default, serde::Serialize, Deserialize)]
struct Flags {
    /// The Guestbook join is announced once, not on every boot: each one shows
    /// up in the member list as a fresh "joined".
    joined_community: Option<String>,
}

fn channel_json(c: &ChannelView) -> Value {
    json!({ "id": c.id_hex, "name": c.name, "private": c.private, "forum": c.forum, "view": c.view, "category": c.category })
}

/// Text channels only: a voice channel has no chat worth reading here.
fn readable(c: &ChannelView) -> bool {
    c.view.as_deref() != Some("voice")
}

#[derive(Deserialize)]
struct Command {
    id: Value,
    op: String,
    channel: Option<String>,
    kind: Option<u16>,
    content: Option<String>,
    #[serde(default)]
    tags: Vec<Vec<String>>,
    limit: Option<usize>,
    since_secs: Option<u64>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    bridge::tls::install();
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let key_file = PathBuf::from(env("CONCORD_IO_KEY_FILE").context("CONCORD_IO_KEY_FILE is required")?);
    let state = PathBuf::from(env("CONCORD_IO_STATE_DIR").context("CONCORD_IO_STATE_DIR is required")?);
    std::fs::create_dir_all(&state)?;
    let primary = read_keys(&key_file)?;
    let membership_path = state.join("membership.json");
    let flags_path = state.join("flags.json");
    let mut flags: Flags = std::fs::read(&flags_path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();

    // ── Membership: stored, else from the invite ────────────────────────────
    let community: Membership = match std::fs::read(&membership_path) {
        Ok(bytes) => serde_json::from_slice(&bytes).context("membership.json is corrupt")?,
        Err(_) => {
            let invite = env("CONCORD_IO_INVITE").context("not a member yet and CONCORD_IO_INVITE is unset")?;
            let link = parse_invite_link(&invite).context("CONCORD_IO_INVITE is not a valid Armada invite")?;
            let bootstrap = Hub::new(Keys::generate()).relays(if link.bootstrap_relays.is_empty() { stock_relays() } else { link.bootstrap_relays });
            let joined = resolve_invite(&invite, &bootstrap).await?.membership;
            save_json(&membership_path, &joined)?;
            tracing::info!(community = %joined.name, "resolved invite");
            joined
        }
    };
    if let Some(epoch) = community.excluded_at {
        emit(json!({ "type": "excluded", "epoch": epoch }));
        bail!("this identity was removed from the community at epoch {epoch}");
    }

    let relays: Relays = Hub::new(primary.clone()).relays(community.relays.clone());

    // Same order as the bridge's start, for the same reason: fold the Control
    // Plane from the root we hold FIRST, so the roster (and so who may vend us
    // a key) is known before any key is accepted.
    let preflight = ConcordClient::new(community.clone(), Arc::new(relays.clone()), primary.clone());
    let folded = preflight.sync_control().await?;
    let base = intake_base_rotations(&relays, &primary, &community, &folded).await;
    if let Some(epoch) = base.excluded {
        let mut gone = community.clone();
        gone.excluded_at = Some(epoch);
        save_json(&membership_path, &gone)?;
        emit(json!({ "type": "excluded", "epoch": epoch }));
        bail!("a Refounding at epoch {epoch} removed us from the community");
    }
    let (community, folded) = match base.adopted {
        None => (community, folded),
        Some(epoch) => {
            tracing::info!(epoch, "took the community's new root");
            let refolded = ConcordClient::new(base.community.clone(), Arc::new(relays.clone()), primary.clone()).sync_control().await?;
            (base.community, refolded)
        }
    };
    // Private-channel keys addressed to us (Direct Invites, access deliveries).
    let floor = relays.with_urls(invite_delivery_relays(&[]));
    let intake = intake_direct_invite_keys(&[&relays, &floor], &primary, &community, &folded).await;
    let mut learned = intake.learned;
    let intake = intake_access_keys(&relays, &primary, &intake.community, &folded).await;
    learned.extend(intake.learned.iter().cloned());
    let intake = KeyIntake { learned, ..intake };
    if !intake.learned.is_empty() {
        tracing::info!(count = intake.learned.len(), "learned private-channel keys");
    }
    let community = intake.community;
    save_json(&membership_path, &community)?;

    let runtime = CommunityRuntime::open(community.clone(), Arc::new(relays.clone()) as Arc<dyn RelayLike>, None).await?;
    runtime.set_on_excluded(Arc::new(|_| emit(json!({ "type": "excluded" }))));
    let client = runtime.client_for(community.clone(), primary.clone());

    if flags.joined_community.as_deref() != Some(community.community_id.as_str()) {
        match client.publish_join(now_ms(), None).await {
            Ok(_) => {
                flags.joined_community = Some(community.community_id.clone());
                save_json(&flags_path, &flags)?;
                tracing::info!("announced our join in the Guestbook");
            }
            Err(error) => tracing::warn!(error = %format!("{error:#}"), "guestbook join failed; retrying next boot"),
        }
    }
    // Where a Direct Invite (say, a private channel's key) should reach us.
    if let Err(error) = client.publish_dm_relays(&primary, &community.relays).await {
        tracing::warn!(error = %format!("{error:#}"), "DM relay list publish failed");
    }

    // ── Live ────────────────────────────────────────────────────────────────
    let on_chat = {
        let client = client.clone();
        Arc::new(move |chat: OpenedChat| forward(&client, chat)) as bridge::client::ChatHandler
    };
    let mut attached: HashMap<String, Attachment> = HashMap::new();
    let mut announced: HashSet<String> = HashSet::new();
    let sync_attachments = |attached: &mut HashMap<String, Attachment>| -> Vec<ChannelView> {
        let channels: Vec<ChannelView> = client.channels().into_iter().filter(readable).collect();
        for c in &channels {
            if !attached.contains_key(&c.id_hex) {
                attached.insert(c.id_hex.clone(), runtime.attach(&c.id_hex, client.clone(), c.clone(), on_chat.clone()));
            }
        }
        let live: HashSet<&str> = channels.iter().map(|c| c.id_hex.as_str()).collect();
        attached.retain(|id, _| live.contains(id.as_str()));
        channels
    };
    let channels = sync_attachments(&mut attached);
    announced.extend(channels.iter().map(|c| format!("{}:{}", c.id_hex, c.name)));
    emit(json!({
        "type": "ready",
        "self": primary.public_key().to_hex(),
        "community": { "id": community.community_id, "name": community.name, "owner": community.owner, "relays": community.relays },
        "channels": channels.iter().map(channel_json).collect::<Vec<_>>(),
    }));
    tracing::info!(community = %community.name, channels = channels.len(), "live");

    let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    let mut tick = tokio::time::interval(RESCAN);
    let mut saved = serde_json::to_string(&*client.community())?;
    let shutdown = shutdown_signal();
    tokio::pin!(shutdown);
    loop {
        tokio::select! {
            _ = &mut shutdown => break,
            line = lines.next_line() => {
                let Some(line) = line? else { break }; // coordinator went away
                if line.trim().is_empty() { continue }
                match serde_json::from_str::<Command>(&line) {
                    Ok(cmd) => { let client = client.clone(); tokio::spawn(async move { run(client, cmd).await }); }
                    Err(error) => emit(json!({ "type": "result", "id": null, "ok": false, "error": format!("bad command: {error}") })),
                }
            }
            _ = tick.tick() => {
                let channels = sync_attachments(&mut attached);
                let now: HashSet<String> = channels.iter().map(|c| format!("{}:{}", c.id_hex, c.name)).collect();
                if now != announced {
                    announced = now;
                    emit(json!({ "type": "channels", "channels": channels.iter().map(channel_json).collect::<Vec<_>>() }));
                }
                // Rekeys and refoundings move the membership while we run.
                let current = serde_json::to_string(&*client.community())?;
                if current != saved {
                    save_json(&membership_path, &*client.community())?;
                    saved = current;
                }
            }
        }
    }
    tracing::info!("shutting down");
    Ok(())
}

/// Hand a post to the coordinator if Armada's readers would see it. A post
/// the judge collapses or holds (a timed-out member, a read-only channel) is
/// not something the community saw, so it is not something to act on.
fn forward(client: &ConcordClient, chat: OpenedChat) {
    if !FORWARDED.contains(&chat.kind()) || client.is_banned(chat.author()) {
        return;
    }
    if !matches!(client.judge(&chat), Verdict::Stands) {
        return;
    }
    let name = client.channel(&chat.channel_id_hex).map(|c| c.name).unwrap_or_default();
    emit(json!({
        "type": "message",
        "channel": chat.channel_id_hex,
        "channel_name": name,
        "id": chat.rumor_id(),
        "pubkey": chat.author(),
        "kind": chat.kind(),
        "content": chat.content(),
        "tags": chat.tags(),
        "ms": chat.ms,
        "moderator": client.is_moderator(chat.author()),
    }));
}

async fn run(client: Arc<ConcordClient>, cmd: Command) {
    let id = cmd.id.clone();
    match dispatch(&client, cmd).await {
        Ok(mut v) => {
            v["type"] = json!("result");
            v["id"] = id;
            v["ok"] = json!(true);
            emit(v);
        }
        Err(error) => emit(json!({ "type": "result", "id": id, "ok": false, "error": format!("{error:#}") })),
    }
}

async fn dispatch(client: &Arc<ConcordClient>, cmd: Command) -> anyhow::Result<Value> {
    let channel = || -> anyhow::Result<ChannelView> {
        let id = cmd.channel.as_deref().context("channel is required")?;
        client.channel(id).with_context(|| format!("no readable channel {id}"))
    };
    match cmd.op.as_str() {
        "send" => {
            let ch = channel()?;
            let content = cmd.content.clone().context("content is required")?;
            let msg = SendChat { content, author: client.primary(), kind: cmd.kind.unwrap_or(kinds::MESSAGE), tags: cmd.tags.clone(), ms: None };
            let (rumor, _) = client.send_chat(&ch, msg).await?;
            Ok(json!({ "rumor_id": rumor.id, "ms": rumor.created_at }))
        }
        "typing" => {
            let ch = channel()?;
            client.send_typing(&ch, client.primary(), now_ms()).await?;
            Ok(json!({}))
        }
        "history" => {
            let ch = channel()?;
            let since = cmd.since_secs.unwrap_or_else(|| (now_ms() / 1000).saturating_sub(3 * 24 * 3600));
            let (chats, _) = client.backfill_channel(&ch, since, cmd.limit.unwrap_or(200)).await?;
            let messages: Vec<Value> = chats
                .iter()
                .filter(|c| FORWARDED.contains(&c.kind()) && matches!(client.judge(c), Verdict::Stands))
                .map(|c| json!({ "id": c.rumor_id(), "pubkey": c.author(), "kind": c.kind(), "content": c.content(), "tags": c.tags(), "ms": c.ms }))
                .collect();
            Ok(json!({ "messages": messages }))
        }
        "channels" => Ok(json!({ "channels": client.channels().iter().filter(|c| readable(c)).map(channel_json).collect::<Vec<_>>() })),
        other => bail!("unknown op {other}"),
    }
}

async fn shutdown_signal() {
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM handler");
    tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {} }
}
