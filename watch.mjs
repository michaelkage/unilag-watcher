import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const STATE_FILE = new URL("./state.json", import.meta.url);
const SOURCES_FILE = new URL("./sources.json", import.meta.url);
const STATE_VERSION = 1;
const UA = "unilag-watcher/1.0 (+https://github.com/michaelkage/unilag-watcher)";

// Forget posts unseen for this long so state.json cannot grow without bound.
const RETENTION_DAYS = 180;

const SEED = process.argv.includes("--seed");
const DRY_RUN = process.argv.includes("--dry-run");

// ---------- helpers ----------

export const decodeEntities = (s) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();

const pickTag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"));
  return m ? decodeEntities(m[1]) : "";
};

// Strip markup so that cosmetic edits (whitespace, tracking attrs) do not
// register as content changes, but real text edits do.
export const plainText = (html) =>
  decodeEntities(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));

export const fingerprint = (text) =>
  createHash("sha256").update(text).digest("hex").slice(0, 16);

export const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const findPdfs = (xml) => {
  const urls = new Set();
  for (const m of xml.matchAll(/href=["']([^"']+\.pdf(?:\?[^"']*)?)["']/gi)) {
    urls.add(decodeEntities(m[1]));
  }
  return [...urls];
};

const absolute = (url) =>
  url.startsWith("//") ? `https:${url}` : url.startsWith("/") ? `https://unilag.edu.ng${url}` : url;

// ---------- feed parsing ----------

export function parseFeed(xml) {
  const items = [];
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = match[1];
    const title = pickTag(block, "title");
    if (!title) continue;

    const link = pickTag(block, "link");
    const guid = pickTag(block, "guid");
    // WordPress exposes a stable numeric post ID via ?p=NNNNN. Prefer it over
    // the URL, which changes when a post slug is edited.
    const idFromUrl = (guid || link).match(/[?&]p=(\d+)/)?.[1];
    const id = idFromUrl ?? link ?? fingerprint(title);

    const content =
      pickTag(block, "content:encoded") || pickTag(block, "description");

    items.push({
      id: String(id),
      title,
      link,
      pubDate: pickTag(block, "pubDate"),
      category: pickTag(block, "category"),
      text: plainText(content),
      hash: fingerprint(plainText(content) + title),
      pdfs: findPdfs(block).map(absolute),
    });
  }
  return items;
}

// ---------- state ----------

// Drop entries not seen for RETENTION_DAYS. Feeds only ever expose a recent
// window, so these can no longer be compared against anything.
export function pruneSeen(seen, now = Date.now()) {
  const cutoff = now - RETENTION_DAYS * 86_400_000;
  const kept = {};
  let dropped = 0;

  for (const [id, entry] of Object.entries(seen)) {
    const seenAt = Date.parse(entry.lastSeen ?? "");
    if (!Number.isFinite(seenAt) || seenAt >= cutoff) kept[id] = entry;
    else dropped++;
  }

  return { kept, dropped };
}

async function loadState() {
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, "utf8"));
    if (parsed.version !== STATE_VERSION) {
      console.warn(`state.json version ${parsed.version} != ${STATE_VERSION}, starting fresh`);
      return { version: STATE_VERSION, lastChange: null, sources: {} };
    }
    return parsed;
  } catch (err) {
    if (err.code !== "ENOENT") console.warn(`could not read state.json (${err.message}), starting fresh`);
    return { version: STATE_VERSION, lastChange: null, sources: {} };
  }
}

// ---------- telegram ----------

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set");
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: false,
    }),
  });

  if (!res.ok) throw new Error(`telegram ${res.status}: ${await res.text()}`);
}

// Telegram caps a message at 4096 chars. Keep well clear of that.
const MAX_MESSAGE = 3800;

export function renderEntries(source, entries) {
  const body = entries
    .map((change) => {
      const badge = change.kind === "new" ? "🆕 NEW" : "✏️ UPDATED";
      const lines = [
        `${badge}  <a href="${escapeHtml(change.item.link)}">${escapeHtml(change.item.title)}</a>`,
      ];
      for (const pdf of change.item.pdfs.slice(0, 3)) lines.push(`📄 ${escapeHtml(pdf)}`);
      return lines.join("\n");
    })
    .join("\n\n");

  return `<b>${escapeHtml(source.label)}</b>\n\n${body}`;
}

export function splitMessage(source, changes) {
  // Greedy pack: keep as many entries per message as fit, never split an entry.
  const chunks = [];
  let current = [];

  for (const change of changes) {
    const candidate = [...current, change];
    if (current.length && renderEntries(source, candidate).length > MAX_MESSAGE) {
      chunks.push(renderEntries(source, current));
      current = [change];
    } else {
      current = candidate;
    }
  }
  if (current.length) chunks.push(renderEntries(source, current));
  return chunks;
}

// ---------- main ----------

async function main() {
  const { sources } = JSON.parse(await readFile(SOURCES_FILE, "utf8"));
  const state = await loadState();
  const now = new Date().toISOString();

  let totalChanges = 0;
  let totalPruned = 0;
  let nextSources = { ...state.sources };

  for (const source of sources) {
    let items;
    try {
      const res = await fetch(source.url, {
        headers: { "user-agent": UA, accept: "application/rss+xml, application/xml, text/xml" },
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      items = parseFeed(await res.text());
    } catch (err) {
      // Leave this source's state untouched so a transient failure is retried
      // on the next run instead of being silently marked as up to date.
      console.error(`[${source.id}] fetch failed: ${err.message} — state left unchanged`);
      continue;
    }

    const seen = state.sources[source.id]?.seen ?? {};
    const keywords = (source.keywords ?? []).map((k) => k.toLowerCase());
    const changes = [];

    for (const item of items) {
      if (keywords.length) {
        const haystack = `${item.title} ${item.text}`.toLowerCase();
        if (!keywords.some((k) => haystack.includes(k))) continue;
      }

      const previous = seen[item.id];
      if (!previous) {
        changes.push({ kind: "new", item });
      } else if (previous.hash !== item.hash) {
        changes.push({ kind: "updated", item });
      }

      seen[item.id] = { hash: item.hash, firstSeen: previous?.firstSeen ?? now, lastSeen: now };
    }

    const { kept, dropped } = pruneSeen(seen);
    if (dropped) console.log(`[${source.id}] pruned ${dropped} stale post(s) older than ${RETENTION_DAYS} days`);

    totalChanges += changes.length;
    totalPruned += dropped;
    nextSources[source.id] = { url: source.url, seen: kept };

    if (SEED) continue;

    if (!changes.length) {
      console.log(`[${source.id}] no changes (${items.length} items checked)`);
      continue;
    }

    console.log(`[${source.id}] ${changes.length} change(s)`);

    if (DRY_RUN) {
      console.log(renderEntries(source, changes));
      continue;
    }

    for (const chunk of splitMessage(source, changes)) {
      await sendTelegram(chunk);
    }
  }

  if (SEED) {
    console.log(`seeded: recorded baseline for ${Object.keys(nextSources).length} source(s), nothing sent`);
  } else if (!DRY_RUN && totalChanges === 0) {
    console.log("no changes across all sources");
  }

  if (DRY_RUN) return;

  // Nothing changed, so leave state.json untouched. Rewriting it just to bump
  // the timestamp would leave the CI working tree dirty every run and produce
  // an empty commit every 30 minutes. Pruning counts as a change, otherwise
  // stale entries would be recomputed and discarded on every run forever.
  if (totalChanges === 0 && totalPruned === 0 && state.lastChange) {
    console.log("state unchanged, not rewritten");
    return;
  }

  // State is written only after every send above succeeded, so a failed
  // notification is retried on the next run instead of being lost.
  const nextState = { version: STATE_VERSION, lastChange: now, sources: nextSources };
  await writeFile(STATE_FILE, `${JSON.stringify(nextState, null, 2)}\n`);
  console.log(`state written (${totalChanges} change(s), ${totalPruned} pruned)`);
}

// Only run when invoked directly, so tests can import the pure functions.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`fatal: ${err.message}`);
    process.exit(1);
  });
}