import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const STATE_FILE = new URL("./state.json", import.meta.url);
const SOURCES_FILE = new URL("./sources.json", import.meta.url);
const STATE_VERSION = 1;
const UA = "unilag-watcher/1.1 (+https://github.com/michaelkage/unilag-watcher)";
const RETENTION_DAYS = 180;
export const DEEP_POLL_DAYS = 60;
export const DEEP_POLL_CONCURRENCY = 4;
const REQUEST_TIMEOUT_MS = 15_000;
const PRIORITY_TERMS = ["timetable", "time table", "schedule", "examination", "exam", "lecture", "academic calendar"];
const SEED = process.argv.includes("--seed");
const DRY_RUN = process.argv.includes("--dry-run");

export const decodeEntities = (s) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();

const pickTag = (xml, name) => {
  const m = xml.match(new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + name + ">", "i"));
  return m ? decodeEntities(m[1]) : "";
};

export const plainText = (html) =>
  decodeEntities(html.replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));

export const fingerprint = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);
export const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const absolute = (url, base = "https://unilag.edu.ng/") => {
  if (!url) return "";
  try { return new URL(url, base).href; } catch { return ""; }
};

export const findPdfs = (html, base = "https://unilag.edu.ng/") => {
  const urls = new Set();
  for (const m of html.matchAll(/(?:href|src)=["']([^"']+\.pdf(?:[?#][^"']*)?)["']/gi)) {
    const url = absolute(decodeEntities(m[1]), base);
    if (url) urls.add(url);
  }
  return [...urls];
};

const isPriority = (item) => {
  const haystack = (item.title || "") + " " + (item.text || "");
  return Boolean(item.pdfs?.length) || PRIORITY_TERMS.some((term) => haystack.toLowerCase().includes(term));
};

export function parseFeed(xml) {
  const items = [];
  for (const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const block = match[1];
    const title = pickTag(block, "title");
    if (!title) continue;
    const link = absolute(pickTag(block, "link"));
    const guid = pickTag(block, "guid");
    const id = (guid || link).match(/[?&]p=(\d+)/)?.[1] ?? link ?? fingerprint(title);
    const content = pickTag(block, "content:encoded") || pickTag(block, "description");
    const text = plainText(content);
    const item = {
      id: String(id), title, link, pubDate: pickTag(block, "pubDate"),
      category: pickTag(block, "category"), text, hash: fingerprint(text + title),
      pdfs: findPdfs(block, link || undefined),
    };
    item.priority = isPriority(item);
    items.push(item);
  }
  return items;
}

/** Parse the actual WordPress article body, excluding site chrome. */
export function parsePostPage(html, requestedUrl, id) {
  const article = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] ?? "";
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? "";
  const scope = article || main;
  const titleMatch = scope.match(/<[^>]*class=["'][^"']*(?:entry-title|post-title)[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i);
  const ogTitle = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
  const documentTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = plainText(decodeEntities(titleMatch?.[1] ?? ogTitle?.[1] ?? documentTitle?.[1] ?? ""))
    .replace(/\s*[|–-]\s*University of Lagos.*$/i, "").trim();

  const marker = scope.search(/class=["'][^"']*(?:entry-content|post-content|wp-block-post-content)[^"']*["']/i);
  const contentStart = marker >= 0 ? scope.lastIndexOf("<", marker) : -1;
  let bodyHtml = contentStart >= 0 ? scope.slice(contentStart) : scope;
  bodyHtml = bodyHtml.replace(/<(header|footer|nav|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
  const text = plainText(bodyHtml);
  if (!title || !text) throw new Error("post " + id + ": page did not contain a readable article");

  const canonical = html.match(/<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)?.[1];
  const canonicalUrl = canonical ? absolute(decodeEntities(canonical)) : "";
  let link = requestedUrl;
  if (canonicalUrl) {
    try {
      const parsedCanonical = new URL(canonicalUrl);
      if (parsedCanonical.protocol === "https:" && ["unilag.edu.ng", "www.unilag.edu.ng"].includes(parsedCanonical.hostname)) link = canonicalUrl;
    } catch { /* retain the already-validated requested permalink */ }
  }
  const item = { id: String(id), title, link, text, pdfs: findPdfs(bodyHtml, link), hash: fingerprint(text + title) };
  item.priority = isPriority(item);
  return item;
}

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

export function isWithinDeepPollWindow(entry, now = Date.now()) {
  const firstSeen = Date.parse(entry.firstSeen ?? "");
  return Number.isFinite(firstSeen) && firstSeen <= now && firstSeen >= now - DEEP_POLL_DAYS * 86_400_000;
}

async function loadState() {
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, "utf8"));
    if (parsed.version !== STATE_VERSION) {
      console.warn("state.json version " + parsed.version + " != " + STATE_VERSION + ", starting fresh");
      return { version: STATE_VERSION, lastChange: null, sources: {} };
    }
    return parsed;
  } catch (err) {
    if (err.code !== "ENOENT") console.warn("could not read state.json (" + err.message + "), starting fresh");
    return { version: STATE_VERSION, lastChange: null, sources: {} };
  }
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set");
  const res = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: false }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error("telegram " + res.status + ": " + await res.text());
}

const MAX_MESSAGE = 3800;

export function renderEntries(source, entries) {
  const body = entries.map((change) => {
    const badge = change.kind === "new" ? "🆕 NEW" : "✏️ UPDATED";
    const lines = [badge + '  <a href="' + escapeHtml(change.item.link) + '">' + escapeHtml(change.item.title) + "</a>"];
    for (const pdf of (change.item.pdfs ?? []).slice(0, 3)) lines.push("📄 " + escapeHtml(pdf));
    return lines.join("\n");
  }).join("\n\n");
  return "<b>" + escapeHtml(source.label) + "</b>\n\n" + body;
}

export function splitMessage(source, changes) {
  const chunks = [];
  let current = [];
  for (const change of changes) {
    const candidate = [...current, change];
    if (current.length && renderEntries(source, candidate).length > MAX_MESSAGE) {
      chunks.push(renderEntries(source, current));
      current = [change];
    } else current = candidate;
  }
  if (current.length) chunks.push(renderEntries(source, current));
  return chunks;
}

export function postUrl(entry, id) {
  // Always resolve by the immutable WordPress database ID. The stored
  // permalink is for human-facing alerts only; its slug can change.
  if (!/^\\d+$/.test(String(id))) {
    throw new Error("invalid WordPress post ID: " + id);
  }
  return "https://unilag.edu.ng/?p=" + encodeURIComponent(String(id));
}

async function fetchPriorityPost(id, entry) {
  const url = postUrl(entry, id);
  const headers = { "user-agent": UA, accept: "text/html,application/xhtml+xml" };
  if (entry.etag) headers["if-none-match"] = entry.etag;
  if (entry.lastModified) headers["if-modified-since"] = entry.lastModified;
  const response = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (response.status === 304) return { notModified: true, url };
  if (!response.ok) throw new Error("HTTP " + response.status);
  const finalUrl = new URL(response.url || url);
  if (!["unilag.edu.ng", "www.unilag.edu.ng"].includes(finalUrl.hostname)) {
    throw new Error("redirected outside unilag.edu.ng (" + finalUrl.hostname + ")");
  }
  const html = await response.text();
  if (/class=["'][^"']*(?:error404|not-found)[^"']*["']/i.test(html) ||
      /<title[^>]*>[^<]*(?:page not found|404)[^<]*<\/title>/i.test(html)) {
    throw new Error("WordPress returned a not-found page");
  }
  const item = parsePostPage(html, finalUrl.href, id);
  return {
    item, etag: response.headers.get("etag") || entry.etag || null,
    lastModified: response.headers.get("last-modified") || entry.lastModified || null,
    url: item.link,
  };
}

async function mapLimit(values, limit, fn) {
  const results = new Array(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      try { results[index] = await fn(values[index]); }
      catch (error) { results[index] = { error }; }
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const { sources } = JSON.parse(await readFile(SOURCES_FILE, "utf8"));
  const state = await loadState();
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const nowMs = nowDate.getTime();
  let totalChanges = 0;
  let totalPruned = 0;
  let totalDeepChecked = 0;
  let totalDeepFailed = 0;
  const nextSources = { ...state.sources };

  for (const source of sources) {
    let items;
    try {
      const response = await fetch(source.url, {
        headers: { "user-agent": UA, accept: "application/rss+xml, application/xml, text/xml" },
        signal: AbortSignal.timeout(45_000),
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      items = parseFeed(await response.text());
    } catch (error) {
      console.error("[" + source.id + "] feed fetch failed: " + error.message + " — state left unchanged");
      continue;
    }

    const seen = { ...(state.sources[source.id]?.seen ?? {}) };
    const keywords = (source.keywords ?? []).map((keyword) => keyword.toLowerCase());
    const changes = [];
    const feedIds = new Set();

    for (const item of items) {
      if (keywords.length) {
        const haystack = (item.title + " " + item.text).toLowerCase();
        if (!keywords.some((keyword) => haystack.includes(keyword))) continue;
      }
      feedIds.add(item.id);
      const previous = seen[item.id];
      if (!previous) changes.push({ kind: "new", item });
      else if (previous.hash !== item.hash) changes.push({ kind: "updated", item });
      seen[item.id] = {
        ...previous, hash: item.hash, firstSeen: previous?.firstSeen ?? now, lastSeen: now,
        link: item.link || previous?.link || null, title: item.title, pdfs: item.pdfs,
        priority: item.priority || previous?.priority === true,
      };
    }

    // Legacy records have no stored title/link/priority. Poll numeric IDs once
    // to classify them, then retain only posts identified as high priority.
    const candidates = Object.entries(seen).filter(([id, entry]) =>
      /^\d+$/.test(id) && !feedIds.has(id) && entry.priority !== false && isWithinDeepPollWindow(entry, nowMs));

    const deepResults = await mapLimit(candidates, DEEP_POLL_CONCURRENCY,
      ([id, entry]) => fetchPriorityPost(id, entry));

    for (let index = 0; index < candidates.length; index++) {
      const id = candidates[index][0];
      const entry = seen[id];
      const result = deepResults[index];
      totalDeepChecked++;
      if (result.error) {
        totalDeepFailed++;
        console.warn("[" + source.id + "] deep-poll " + id + " failed: " + result.error.message + " — retaining previous fingerprint");
        continue;
      }
      if (result.notModified) continue;
      const item = result.item;
      if (!item.priority) {
        // Never demote a post already tagged from its RSS payload: the HTML
        // template may expose fewer attachment/text details than the feed.
        seen[id] = {
          ...entry,
          priority: entry.priority === true,
          link: result.url,
          title: item.title,
          pdfs: item.pdfs,
          etag: result.etag,
          lastModified: result.lastModified,
        };
        continue;
      }
      // Legacy entries have no priority flag and may have a feed hash that is
      // not byte-for-byte comparable to the article extraction. Establish a
      // direct-page baseline once; only already-tagged posts can alert here.
      if (entry.priority === true && entry.hash && entry.hash !== item.hash) {
        changes.push({ kind: "updated", item });
      }
      seen[id] = {
        ...entry, hash: item.hash, link: result.url, title: item.title, pdfs: item.pdfs,
        priority: true, etag: result.etag, lastModified: result.lastModified,
      };
    }

    const { kept, dropped } = pruneSeen(seen, nowMs);
    if (dropped) console.log("[" + source.id + "] pruned " + dropped + " stale post(s)");
    totalChanges += changes.length;
    totalPruned += dropped;
    nextSources[source.id] = { url: source.url, seen: kept };

    if (SEED) continue;
    if (!changes.length) {
      console.log("[" + source.id + "] no changes (" + items.length + " feed items, " + candidates.length + " deep-poll candidates)");
      continue;
    }
    console.log("[" + source.id + "] " + changes.length + " change(s)");
    if (DRY_RUN) {
      console.log(renderEntries(source, changes));
      continue;
    }
    for (const chunk of splitMessage(source, changes)) await sendTelegram(chunk);
  }

  console.log("deep-poll summary: " + totalDeepChecked + " checked, " + totalDeepFailed + " failed");
  if (SEED) console.log("seeded: recorded baseline for " + Object.keys(nextSources).length + " source(s), nothing sent");
  else if (!DRY_RUN && totalChanges === 0) console.log("no changes across all sources");
  if (DRY_RUN) return;

  const stateChanged = JSON.stringify(state.sources) !== JSON.stringify(nextSources);
  if (totalChanges === 0 && totalPruned === 0 && !stateChanged && state.lastChange) {
    console.log("state unchanged, not rewritten");
    return;
  }
  // Fingerprints advance only after all Telegram sends succeed; failed sends
  // therefore retry on the next scheduled run.
  await writeFile(STATE_FILE, JSON.stringify({ version: STATE_VERSION, lastChange: now, sources: nextSources }, null, 2) + "\n");
  console.log("state written (" + totalChanges + " change(s), " + totalPruned + " pruned)");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("fatal: " + error.message);
    process.exit(1);
  });
}
