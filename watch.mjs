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
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const PRIORITY_PATTERN = /\b(?:time\s*table|schedule|examinations?|exams?|lectures?|academic\s+calendar)\b/i;
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
  return Boolean(item.pdfs?.length) || PRIORITY_PATTERN.test(haystack);
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

export const deepPageChanged = (entry, item) =>
  entry.priority === true &&
  entry.deepHashVersion === 2 &&
  typeof entry.deepHash === "string" &&
  entry.deepHash !== item.hash;

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
  if (!/^\d+$/.test(String(id))) {
    throw new Error("invalid WordPress post ID: " + id);
  }
  return "https://unilag.edu.ng/?p=" + encodeURIComponent(String(id));
}

async function fetchPdfFingerprints(urls, previousHashes = {}, previousValidators = {}) {
  const hashes = {};
  const validators = {};

  for (const rawUrl of urls) {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") throw new Error("refusing non-HTTPS PDF attachment: " + rawUrl);

    // Only download attachments hosted by UNILAG. External PDF links are still
    // represented in the aggregate fingerprint by URL, but are not fetched.
    if (!["unilag.edu.ng", "www.unilag.edu.ng"].includes(url.hostname)) {
      hashes[rawUrl] = "external";
      continue;
    }

    const previous = previousValidators[rawUrl] ?? {};
    const headers = { "user-agent": UA, accept: "application/pdf,application/octet-stream" };
    if (previous.etag) headers["if-none-match"] = previous.etag;
    if (previous.lastModified) headers["if-modified-since"] = previous.lastModified;

    const response = await fetch(rawUrl, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.status === 304) {
      if (!previousHashes[rawUrl]) throw new Error("PDF returned 304 without a cached fingerprint: " + rawUrl);
      hashes[rawUrl] = previousHashes[rawUrl];
      validators[rawUrl] = previous;
      continue;
    }
    if (!response.ok) throw new Error("PDF HTTP " + response.status + ": " + rawUrl);

    const finalUrl = new URL(response.url || rawUrl);
    if (finalUrl.protocol !== "https:" || !["unilag.edu.ng", "www.unilag.edu.ng"].includes(finalUrl.hostname)) {
      throw new Error("PDF redirected outside UNILAG: " + rawUrl);
    }

    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > MAX_PDF_BYTES) throw new Error("PDF exceeds 25 MiB limit: " + rawUrl);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_PDF_BYTES) throw new Error("PDF exceeds 25 MiB limit: " + rawUrl);
    if (!bytes.subarray(0, 1024).includes(Buffer.from("%PDF-"))) {
      throw new Error("attachment response is not a valid PDF: " + rawUrl);
    }

    hashes[rawUrl] = createHash("sha256").update(bytes).digest("hex");
    validators[rawUrl] = {
      etag: response.headers.get("etag") || previous.etag || null,
      lastModified: response.headers.get("last-modified") || previous.lastModified || null,
    };
  }

  return { hashes, validators };
}

export const combinedDeepHash = (bodyHash, pdfHashes) => {
  const attachments = Object.entries(pdfHashes).sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256")
    .update(bodyHash)
    .update(JSON.stringify(attachments))
    .digest("hex")
    .slice(0, 16);
};

async function fetchPriorityPost(id, entry) {
  const url = postUrl(entry, id);
  const headers = { "user-agent": UA, accept: "text/html,application/xhtml+xml" };
  if (entry.etag && (entry.deepBodyHash || entry.deepHash)) headers["if-none-match"] = entry.etag;
  if (entry.lastModified && (entry.deepBodyHash || entry.deepHash)) headers["if-modified-since"] = entry.lastModified;

  const response = await fetch(url, {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const finalUrl = new URL(response.url || url);
  if (!["unilag.edu.ng", "www.unilag.edu.ng"].includes(finalUrl.hostname)) {
    throw new Error("redirected outside unilag.edu.ng (" + finalUrl.hostname + ")");
  }

  if (response.status === 304) {
    const bodyHash = entry.deepBodyHash || entry.deepHash;
    if (!bodyHash) throw new Error("post returned 304 without a cached body fingerprint: " + id);
    const pdfs = entry.deepPdfs ?? entry.pdfs ?? [];
    const { hashes, validators } = await fetchPdfFingerprints(
      pdfs,
      entry.pdfHashes ?? {},
      entry.pdfValidators ?? {},
    );
    const item = {
      id: String(id),
      title: entry.title || "UNILAG announcement",
      link: entry.link || finalUrl.href,
      pdfs,
      hash: combinedDeepHash(bodyHash, hashes),
    };
    return {
      notModified: true,
      item,
      deepBodyHash: bodyHash,
      pdfHashes: hashes,
      pdfValidators: validators,
      etag: response.headers.get("etag") || entry.etag || null,
      lastModified: response.headers.get("last-modified") || entry.lastModified || null,
      url: item.link,
    };
  }

  if (!response.ok) throw new Error("HTTP " + response.status);
  const html = await response.text();
  if (/class=["'][^"']*(?:error404|not-found)[^"']*["']/i.test(html) ||
      /<title[^>]*>[^<]*(?:page not found|404)[^<]*<\/title>/i.test(html)) {
    throw new Error("WordPress returned a not-found page");
  }

  const item = parsePostPage(html, finalUrl.href, id);
  const deepBodyHash = item.hash;
  const { hashes, validators } = await fetchPdfFingerprints(
    item.pdfs,
    entry.pdfHashes ?? {},
    entry.pdfValidators ?? {},
  );
  item.hash = combinedDeepHash(deepBodyHash, hashes);

  return {
    item,
    deepBodyHash,
    pdfHashes: hashes,
    pdfValidators: validators,
    etag: response.headers.get("etag") || entry.etag || null,
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

    // Poll tagged priority posts on every run, including while they remain in
    // RSS. Unclassified legacy numeric IDs are checked once for migration.
    const candidates = Object.entries(seen).filter(([id, entry]) =>
      /^\d+$/.test(id) &&
      isWithinDeepPollWindow(entry, nowMs) &&
      (entry.priority === true || (!feedIds.has(id) && entry.priority !== false)));

    const deepResults = await mapLimit(candidates, DEEP_POLL_CONCURRENCY,
      ([id, entry]) => fetchPriorityPost(id, entry));

    for (let index = 0; index < candidates.length; index++) {
      const id = candidates[index][0];
      const entry = seen[id];
      const result = deepResults[index];
      totalDeepChecked++;

      if (result.error) {
        totalDeepFailed++;
        console.warn("[" + source.id + "] deep-poll " + id + " failed: " + result.error.message + " — retaining previous fingerprints");
        continue;
      }
      if (result.notModified) {
        const item = result.item;
        if (deepPageChanged(entry, item) &&
            !changes.some((change) => change.item.id === id)) {
          changes.push({ kind: "updated", item });
        }
        seen[id] = {
          ...entry,
          deepHash: item.hash,
          deepHashVersion: 2,
          deepBodyHash: result.deepBodyHash,
          pdfHashes: result.pdfHashes,
          pdfValidators: result.pdfValidators,
          pdfs: item.pdfs,
          deepPdfs: item.pdfs,
          etag: result.etag,
          lastModified: result.lastModified,
        };
        continue;
      }

      const item = result.item;
      const wasPriority = entry.priority === true;
      if (!wasPriority && !item.priority) {
        // One-time migration check for older state entries. Non-priority
        // records are marked false so they do not consume requests again.
        seen[id] = {
          ...entry,
          priority: false,
          link: result.url,
          title: item.title,
          pdfs: item.pdfs,
          etag: result.etag,
          lastModified: result.lastModified,
        };
        continue;
      }

      // RSS and article-page extraction are different representations.
      // Keep their fingerprints separate to prevent cross-format false alerts.
      // A legacy post gets a direct-page baseline on its first successful poll.
      if (deepPageChanged(entry, item) &&
          !changes.some((change) => change.item.id === id)) {
        changes.push({ kind: "updated", item });
      }

      seen[id] = {
        ...entry,
        deepHash: item.hash,
        deepHashVersion: 2,
        deepBodyHash: result.deepBodyHash,
        pdfHashes: result.pdfHashes,
        pdfValidators: result.pdfValidators,
        link: result.url,
        title: item.title,
        pdfs: item.pdfs,
        deepPdfs: item.pdfs,
        priority: true,
        etag: result.etag,
        lastModified: result.lastModified,
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
