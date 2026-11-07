# Sift

A full-text search index written from scratch: an inverted index with positions, BM25
ranking, AND semantics, phrase queries and prefix expansion.

Zero dependencies. The point is the ranking maths and the positional index, not wrapping a
search engine.

## Run it

```bash
node --test
```

```ts
import { SearchIndex } from "./src/search.ts";

const index = new SearchIndex();
index.add({ id: "1", text: "Postgres advisory locks prevent duplicate claims" });

index.search("advisory locks");          // ranked hits
index.search("adv", { prefix: true });   // search-as-you-type
index.phrase("advisory locks");          // adjacent terms only
```

## The hard part: ranking that is actually defensible

Counting matching terms gives you garbage — every document containing "the" scores the same.
Sift scores with **BM25**, which combines three ideas that each fix a specific failure:

- **IDF** (`log(1 + (N - df + 0.5) / (df + 0.5))`) makes rare terms worth more. A document
  containing "idempotency" should outrank one containing "system" five times.
- **Term-frequency saturation** (the `tf * (k1 + 1) / (tf + k1 * ...)` term with `k1 = 1.2`)
  means the tenth mention of a word is almost worthless compared with the second. Without
  this, keyword stuffing wins.
- **Length normalisation** (`b = 0.75`) stops a long document from outranking a short, focused
  one purely because it has more room to repeat itself.

All three are constants you can read and tune in `src/search.ts` rather than knobs hidden
inside a library.

## Design decisions

**Positions, not just counts.** The index stores the offset of every occurrence, which is what
makes `phrase()` possible: "database connection" must find genuinely adjacent tokens, not two
words that happen to appear somewhere in the same paragraph. Storing counts only would make
phrase search a lie.

**AND semantics by default.** A query returns documents containing every term. It is
predictable, and it matches how people type into a search box ("postgres advisory locks"
should not return unrelated React articles).

**Candidates come from the smallest posting list.** For an AND query, intersecting against the
rarest term first means the work scales with the number of matches, not the size of the corpus.

**Prefix expansion is capped at 50 terms.** An unbounded scan over the vocabulary on every
keystroke is how a search box becomes a denial-of-service vector.

**Scores are rounded to six decimals before sorting.** Floating-point noise otherwise makes
ordering depend on insertion order, which makes results non-reproducible.

## Tests

Tokenisation and stopword removal, duplicate-id rejection, AND semantics, rare-term ranking,
term-frequency saturation, length normalisation, score ordering and limits, matched-term
reporting for highlighting, phrase adjacency and word order, single-word phrases, prefix
expansion with and without the flag, removal clearing posting lists, and empty-index safety.
