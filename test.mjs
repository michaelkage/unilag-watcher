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