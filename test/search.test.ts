import test from "node:test";
import assert from "node:assert/strict";
import { SearchIndex, tokenize } from "../src/search.ts";

function corpus(): SearchIndex {
  const index = new SearchIndex();
  for (const doc of [
    { id: "d1", text: "Postgres advisory locks prevent duplicate job claims", metadata: { team: "platform" } },
    { id: "d2", text: "Postgres indexes speed up queries over large tables", metadata: { team: "data" } },
    { id: "d3", text: "Advisory locks and transaction isolation in Postgres", metadata: { team: "platform" } },
    { id: "d4", text: "React renders a component tree into the DOM", metadata: { team: "web" } },
    { id: "d5", text: "The quick brown fox jumps over the lazy dog" },
  ]) {
    index.add(doc);
  }
  return index;
}

test("tokenisation lowercases, splits and drops stopwords", () => {
  assert.deepEqual(tokenize("The QUICK, brown-fox!"), ["quick", "brown", "fox"]);
  assert.deepEqual(tokenize("a an the of"), [], "stopwords and single characters disappear");
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize("x y z"), [], "one-character tokens are noise");
});

test("indexing tracks documents and vocabulary", () => {
  const index = corpus();
  assert.equal(index.size, 5);
  assert.ok(index.vocabularySize > 10);
  assert.deepEqual(index.document("d1")!.metadata, { team: "platform" });
  assert.equal(index.document("nope"), null);
});

test("a document cannot be indexed twice", () => {
  const index = corpus();
  assert.throws(() => index.add({ id: "d1", text: "again" }), RangeError);
  assert.throws(() => index.add({ id: "", text: "blank" }), RangeError);
});

test("every query term must match", () => {
  const index = corpus();
  assert.deepEqual(index.search("postgres advisory").map((h) => h.id).sort(), ["d1", "d3"]);
  assert.deepEqual(index.search("postgres fox"), [], "one missing term means no match");
  assert.deepEqual(index.search("nonexistent"), []);
  assert.deepEqual(index.search(""), [], "an empty query returns nothing, not everything");
  assert.deepEqual(index.search("   the  "), []);
});

test("rare terms carry more weight than common ones", () => {
  const index = new SearchIndex();
  index.add({ id: "common", text: "postgres postgres postgres postgres postgres" });
  index.add({ id: "rare", text: "postgres advisory" });
  index.add({ id: "filler", text: "postgres something else entirely" });

  assert.deepEqual(index.search("advisory").map((h) => h.id), ["rare"], "only the document containing the term");
  assert.ok(
    index.idf("advisory") > index.idf("postgres"),
    "a term found in one document must weigh more than one found in all three",
  );

  const ranked = index.search("postgres advisory");
  assert.equal(ranked.length, 1, "AND semantics keeps only the document containing both");
  assert.equal(ranked[0].id, "rare");
  assert.ok(ranked[0].score > 0);
});

test("repeating a term saturates instead of dominating", () => {
  const index = new SearchIndex();
  index.add({ id: "once", text: "alpha beta gamma delta epsilon" });
  index.add({ id: "many", text: "alpha alpha alpha alpha alpha" });

  const scores = index.search("alpha");
  const once = scores.find((h) => h.id === "once")!;
  const many = scores.find((h) => h.id === "many")!;
  assert.ok(many.score > once.score, "term frequency still helps");
  assert.ok(many.score < once.score * 10, "but BM25 saturation limits how much");
});

test("shorter documents win ties in term frequency, all else equal", () => {
  const index = new SearchIndex();
  index.add({ id: "short", text: "rails caching" });
  index.add({ id: "long", text: "rails caching is described here across many unrelated words about weather" });

  const [first] = index.search("caching");
  assert.equal(first.id, "short", "length normalisation must not favour padding");
});

test("results are ordered by descending score and honour the limit", () => {
  const index = corpus();
  const hits = index.search("postgres locks advisory", { limit: 2 });
  assert.ok(hits.length <= 2);
  for (let i = 1; i < hits.length; i++) {
    assert.ok(hits[i - 1].score >= hits[i].score, "scores must be non-increasing");
  }
  assert.throws(() => index.search("postgres", { limit: 0 }), RangeError);
});

test("matched terms are reported so callers can highlight them", () => {
  const index = corpus();
  const hit = index.search("advisory locks").find((h) => h.id === "d1")!;
  assert.deepEqual(hit.matchedTerms, ["advisory", "locks"]);
  assert.equal(hit.metadata.team, "platform", "metadata travels with the hit");
});

test("phrase search requires adjacency, not just co-occurrence", () => {
  const index = new SearchIndex();
  index.add({ id: "adjacent", text: "database connection pooling" });
  index.add({ id: "scattered", text: "database sharding is unrelated to connection settings" });

  assert.deepEqual(index.phrase("database connection").map((h) => h.id), ["adjacent"]);
  assert.deepEqual(index.search("database connection").map((h) => h.id).sort(), ["adjacent", "scattered"]);
  assert.deepEqual(index.phrase("connection database"), [], "phrase order matters");
  assert.deepEqual(index.phrase("").map((h) => h.id), []);
});

test("a single-word phrase behaves like a term search", () => {
  const index = corpus();
  assert.deepEqual(index.phrase("react").map((h) => h.id), ["d4"]);
});

test("prefix search expands the final term", () => {
  const index = new SearchIndex();
  index.add({ id: "a", text: "authentication middleware" });
  index.add({ id: "b", text: "authorisation rules" });
  index.add({ id: "c", text: "authoring documents" });

  const expanded = index.search("auth", { prefix: true }).map((h) => h.id).sort();
  assert.deepEqual(expanded, ["a", "b", "c"]);

  assert.deepEqual(index.search("auth").map((h) => h.id), [], "without prefix mode it is an exact term");
  assert.deepEqual(index.search("autho", { prefix: true }).map((h) => h.id).sort(), ["b", "c"]);
});

test("removal drops the document from every posting list", () => {
  const index = corpus();
  assert.equal(index.remove("d1"), true);
  assert.equal(index.remove("d1"), false);
  assert.equal(index.size, 4);
  assert.deepEqual(index.search("duplicate").map((h) => h.id), [], "its unique term is gone");
  assert.deepEqual(index.search("postgres").map((h) => h.id).sort(), ["d2", "d3"]);
});

test("an empty index answers safely", () => {
  const index = new SearchIndex();
  assert.deepEqual(index.search("anything"), []);
  assert.deepEqual(index.phrase("anything at all"), []);
  assert.equal(index.size, 0);
});
