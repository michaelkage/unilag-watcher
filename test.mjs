import { test } from "node:test";
import assert from "node:assert/strict";

import {
  decodeEntities,
  plainText,
  fingerprint,
  findPdfs,
  escapeHtml,
  parseFeed,
  renderEntries,
  splitMessage,
  pruneSeen,
  parsePostPage,
  isWithinDeepPollWindow,
  postUrl,
  deepPageChanged,
  combinedDeepHash,
} from "./watch.mjs";

const FEED = `<?xml version="1.0"?>
<rss version="2.0"><channel>
<title>University Of Lagos</title>
<item>
  <title>GST: Amended Final Examination Timetable &amp; Guidelines</title>
  <link>https://unilag.edu.ng/gst-amended-final-exam-timetable/</link>
  <guid isPermaLink="false">https://unilag.edu.ng/?p=80123</guid>
  <pubDate>Mon, 05 Oct 2026 09:00:00 +0000</pubDate>
  <category><![CDATA[Unilag General News]]></category>
  <description><![CDATA[<p>The timetable has been <strong>revised</strong>.
  See <a href="https://unilag.edu.ng/wp-content/uploads/2026/10/gst-timetable.pdf">the PDF</a>.</p>]]></description>
</item>
<item>
  <title>Staff School at 60</title>
  <link>https://unilag.edu.ng/staff-school-at-60/</link>
  <guid isPermaLink="false">https://unilag.edu.ng/?p=80541</guid>
  <pubDate>Fri, 02 Oct 2026 18:37:57 +0000</pubDate>
  <description><![CDATA[<p>Anniversary parade.</p>]]></description>
</item>
</channel></rss>`;

test("decodeEntities unwraps CDATA and resolves named and numeric entities", () => {
  assert.equal(decodeEntities("<![CDATA[<p>hi</p>]]>"), "<p>hi</p>");
  assert.equal(decodeEntities("Ogunwolu &amp; Mowete"), "Ogunwolu & Mowete");
  assert.equal(decodeEntities("Nigeria&#8217;s"), "Nigeria\u2019s");
  assert.equal(decodeEntities("AT&amp;T"), "AT&T");
});

test("plainText strips markup and collapses whitespace", () => {
  assert.equal(plainText("<p>one   two</p>\n<p>three</p>"), "one two three");
});

test("fingerprint ignores cosmetic edits but catches real ones", () => {
  const a = fingerprint(plainText("<p>The timetable has been revised.</p>"));
  const b = fingerprint(plainText("<p>  The   timetable  has been revised.  </p>"));
  const c = fingerprint(plainText("<p>The timetable has been POSTPONED.</p>"));
  assert.equal(a, b, "whitespace/markup changes must not alter the fingerprint");
  assert.notEqual(a, c, "a real text change must alter the fingerprint");
});

test("parseFeed reads post IDs from guid so slug edits do not orphan posts", () => {
  const items = parseFeed(FEED);
  assert.equal(items.length, 2);
  assert.equal(items[0].id, "80123");
  assert.equal(items[1].id, "80541");
});

test("parseFeed decodes entities in titles and keeps the category", () => {
  const [first] = parseFeed(FEED);
  assert.equal(first.title, "GST: Amended Final Examination Timetable & Guidelines");
  assert.equal(first.category, "Unilag General News");
  assert.match(first.text, /has been revised/);
});

test("parseFeed extracts and absolutises PDF links", () => {
  const [first] = parseFeed(FEED);
  assert.deepEqual(first.pdfs, ["https://unilag.edu.ng/wp-content/uploads/2026/10/gst-timetable.pdf"]);
});

test("findPdfs returns nothing when a post has no PDF", () => {
  assert.deepEqual(findPdfs("<p>no attachments here</p>"), []);
});

test("a revised post changes its fingerprint, an untouched one does not", () => {
  const before = parseFeed(FEED)[0].hash;
  const amended = parseFeed(FEED.replace("revised", "POSTPONED")).map((i) => i.hash);
  const unchanged = parseFeed(FEED.replace("Anniversary", "Anniversary")).map((i) => i.hash);
  assert.notEqual(amended[0], before, "amended timetable must read as UPDATED");
  assert.equal(unchanged[0], before, "identical post must not read as UPDATED");
});

test("pruneSeen drops entries past retention but keeps recent ones", () => {
  const now = Date.parse("2026-10-02T00:00:00Z");
  const seen = {
    recent: { hash: "a", lastSeen: "2026-09-30T00:00:00Z" },
    ancient: { hash: "b", lastSeen: "2020-01-01T00:00:00Z" },
    undated: { hash: "c" },
  };
  const { kept, dropped } = pruneSeen(seen, now);
  assert.deepEqual(Object.keys(kept).sort(), ["recent", "undated"]);
  assert.equal(dropped, 1);
});

test("escapeHtml escapes the three characters Telegram HTML mode chokes on", () => {
  assert.equal(escapeHtml("Tom & Jerry <b>bold</b>"), "Tom &amp; Jerry &lt;b&gt;bold&lt;/b&gt;");
});

test("renderEntries labels new and updated posts distinctly", () => {
  const item = { title: "Timetable", link: "https://unilag.edu.ng/x/", pdfs: [] };
  const out = renderEntries({ label: "Exam Timetable" }, [
    { kind: "new", item },
    { kind: "updated", item },
  ]);
  assert.match(out, /Exam Timetable/);
  assert.match(out, /NEW/);
  assert.match(out, /UPDATED/);
});

test("splitMessage never drops or truncates an entry when output overflows", () => {
  const source = { label: "News" };
  const changes = Array.from({ length: 40 }, (_, n) => ({
    kind: "new",
    item: {
      title: `Post number ${n} ${"x".repeat(300)}`,
      link: `https://unilag.edu.ng/${n}/`,
      pdfs: [],
    },
  }));

  const chunks = splitMessage(source, changes);
  assert.ok(chunks.length > 1, "should have split across several messages");
  for (const chunk of chunks) {
    assert.ok(chunk.length < 4096, `chunk of ${chunk.length} chars exceeds the Telegram limit`);
  }

  const joined = chunks.join("\n");
  for (let n = 0; n < 40; n++) {
    assert.match(joined, new RegExp(`Post number ${n} `), `entry ${n} was lost`);
  }
});

test("priority feed metadata flags timetable posts and PDF attachments", () => {
  const [timetable, ordinary] = parseFeed(FEED);
  assert.equal(timetable.priority, true);
  assert.equal(ordinary.priority, false);
  const exampleOnly = parseFeed(FEED.replace("Staff School at 60", "Example of a campus event"));
  assert.equal(exampleOnly[1].priority, false, "the word example must not accidentally match exam");
});

test("priority detection includes plural timetable, schedule, and calendar terms", () => {
  for (const title of ["Exam Timetables", "Lecture Schedules", "Academic Calendars"]) {
    const xml = FEED.replace("GST Examination Timetable", title);
    assert.equal(parseFeed(xml)[0].priority, true, title + " should be priority");
  }
});

test("parsePostPage fingerprints article content, not site navigation", () => {
  const page = `<!doctype html><html><head><title>GST Examination Timetable | University of Lagos</title></head>
  <body class="postid-80123"><nav>Navigation that must not affect the hash</nav><article>
  <h1 class="entry-title">GST Examination Timetable</h1>
  <div class="entry-content"><p>Exam starts at 9am in Hall A.</p>
  <a href="/wp-content/uploads/exam.pdf">Download</a></div>
  </article><footer>Footer text must not affect the hash</footer></body></html>`;
  const parsed = parsePostPage(page, "https://unilag.edu.ng/?p=80123", "80123");
  assert.equal(parsed.title, "GST Examination Timetable");
  assert.match(parsed.text, /Exam starts at 9am in Hall A/);
  assert.equal(parsed.priority, true);
  assert.deepEqual(parsed.pdfs, ["https://unilag.edu.ng/wp-content/uploads/exam.pdf"]);
  assert.throws(
    () => parsePostPage(page.replace("postid-80123", "postid-999"), "https://unilag.edu.ng/?p=80123", "80123"),
    /different post than requested ID/,
  );
  assert.throws(
    () => parsePostPage(page.replace(' class="postid-80123"', ""), "https://unilag.edu.ng/?p=80123", "80123"),
    /did not expose a verifiable post ID/,
    "a page without a WordPress identity marker must not be trusted",
  );
  const cosmetic = page.replace("Navigation that must not affect the hash", "Different navigation")
    .replace("Footer text must not affect the hash", "Different footer");
  assert.equal(parsePostPage(cosmetic, "https://unilag.edu.ng/?p=80123", "80123").hash, parsed.hash);
});

test("deep-poll window uses firstSeen and excludes records older than 60 days", () => {
  const now = Date.parse("2026-11-11T00:00:00Z");
  assert.equal(isWithinDeepPollWindow({ firstSeen: "2026-10-12T00:00:00Z" }, now), true);
  assert.equal(isWithinDeepPollWindow({ firstSeen: "2026-09-01T00:00:00Z" }, now), false);
  assert.equal(isWithinDeepPollWindow({ firstSeen: "2026-11-12T00:00:00Z" }, now), false);
  assert.equal(isWithinDeepPollWindow({}, now), false);
});


test("deep polling always uses immutable WordPress post IDs, not mutable slugs", () => {
  assert.equal(
    postUrl({ link: "https://unilag.edu.ng/old-timetable-slug/" }, "80123"),
    "https://unilag.edu.ng/?p=80123",
  );
  assert.throws(() => postUrl({}, "../not-an-id"), /invalid WordPress post ID/);
});


test("RSS and deep-page fingerprints are compared only within their own formats", () => {
  const item = { hash: "direct-page-hash" };
  assert.equal(deepPageChanged({
    priority: true,
    deepHashVersion: 2,
    hash: "rss-hash",
    deepHash: "direct-page-hash",
  }, item), false);
  assert.equal(deepPageChanged({
    priority: true,
    deepHashVersion: 2,
    hash: "rss-hash",
    deepHash: "previous-direct-hash",
  }, item), true);
  assert.equal(deepPageChanged({
    priority: true,
    hash: "rss-hash",
  }, item), false, "the first direct poll establishes a baseline");
  assert.equal(deepPageChanged({
    priority: false,
    deepHash: "previous-direct-hash",
  }, item), false);
});


test("PDF byte fingerprints contribute to the deep-page fingerprint", () => {
  const body = "same-article-body";
  const first = combinedDeepHash(body, {
    "https://unilag.edu.ng/timetable.pdf": "pdf-bytes-a",
  });
  const replacedPdf = combinedDeepHash(body, {
    "https://unilag.edu.ng/timetable.pdf": "pdf-bytes-b",
  });
  const addedPdf = combinedDeepHash(body, {
    "https://unilag.edu.ng/timetable.pdf": "pdf-bytes-a",
    "https://unilag.edu.ng/venue-map.pdf": "pdf-bytes-c",
  });
  assert.notEqual(first, replacedPdf);
  assert.notEqual(first, addedPdf);
  assert.equal(first, combinedDeepHash(body, {
    "https://unilag.edu.ng/timetable.pdf": "pdf-bytes-a",
  }));
});
