/**
 * A full-text index built from first principles: tokenise, invert, score, rank.
 *
 * No dependency does the interesting part — the point of this project is the ranking
 * maths and the positional index, not wrapping an existing search library.
 */

export interface Document {
  id: string;
  text: string;
  metadata?: Record<string, string>;
}

export interface Hit {
  id: string;
  score: number;
  metadata: Record<string, string>;
  matchedTerms: string[];
}

export interface SearchOptions {
  limit?: number;
  /** Expand the final term as a prefix, the way a search box behaves while typing. */
  prefix?: boolean;
}

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "has", "have",
  "in", "is", "it", "its", "of", "on", "or", "that", "the", "to", "was", "were", "with",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

const K1 = 1.2;
const B = 0.75;

export class SearchIndex {
  /** term -> document id -> positions */
  private postings = new Map<string, Map<string, number[]>>();
  private lengths = new Map<string, number>();
  private documents = new Map<string, Document>();

  get size(): number {
    return this.documents.size;
  }

  get vocabularySize(): number {
    return this.postings.size;
  }

  add(doc: Document): void {
    if (!doc?.id) throw new RangeError("document needs an id");
    if (this.documents.has(doc.id)) throw new RangeError(`document already indexed: ${doc.id}`);

    const tokens = tokenize(doc.text ?? "");
    this.documents.set(doc.id, { ...doc, metadata: { ...(doc.metadata ?? {}) } });
    this.lengths.set(doc.id, tokens.length);

    tokens.forEach((term, position) => {
      let byDoc = this.postings.get(term);
      if (!byDoc) {
        byDoc = new Map();
        this.postings.set(term, byDoc);
      }
      const positions = byDoc.get(doc.id);
      if (positions) positions.push(position);
      else byDoc.set(doc.id, [position]);
    });
  }

  remove(id: string): boolean {
    if (!this.documents.delete(id)) return false;
    this.lengths.delete(id);
    for (const [term, byDoc] of this.postings) {
      byDoc.delete(id);
      if (byDoc.size === 0) this.postings.delete(term);
    }
    return true;
  }

  private averageLength(): number {
    if (this.documents.size === 0) return 0;
    let total = 0;
    for (const len of this.lengths.values()) total += len;
    return total / this.documents.size;
  }

  /** Inverse document frequency with the standard BM25 smoothing. Public so ranking is testable. */
  idf(term: string): number {
    const df = this.postings.get(term)?.size ?? 0;
    if (df === 0) return 0;
    return Math.log(1 + (this.documents.size - df + 0.5) / (df + 0.5));
  }

  private expandPrefix(term: string): string[] {
    const matches: string[] = [];
    for (const candidate of this.postings.keys()) {
      if (candidate.startsWith(term)) matches.push(candidate);
    }
    return matches.slice(0, 50);
  }

  /**
   * All query terms must appear (AND semantics). Ranking is BM25, which rewards rare terms
   * and saturates repeated ones, then normalises by document length so long documents do
   * not win by sheer size.
   */
  search(query: string, opts: SearchOptions = {}): Hit[] {
    const limit = opts.limit ?? 10;
    if (!Number.isInteger(limit) || limit <= 0) throw new RangeError("limit must be positive");

    const terms = tokenize(query ?? "");
    if (terms.length === 0) return [];

    const expansions: string[][] = terms.map((term, i) =>
      opts.prefix && i === terms.length - 1 ? this.expandPrefix(term) : [term],
    );
    if (expansions.some((group) => group.length === 0)) return [];

    // Candidate documents are those in the smallest expansion group, so an AND query does
    // not scan the whole corpus for a term that is already rare.
    const groups = expansions.map((group) => {
      const docs = new Set<string>();
      for (const term of group) {
        const byDoc = this.postings.get(term);
        if (!byDoc) continue; // a term nobody uses matches nothing
        for (const id of byDoc.keys()) docs.add(id);
      }
      return docs;
    });
    if (groups.some((group) => group.size === 0)) return [];
    groups.sort((a, b) => a.size - b.size);

    const candidates = [...groups[0]].filter((id) => groups.every((g) => g.has(id)));
    if (candidates.length === 0) return [];

    const avg = this.averageLength() || 1;
    const idfCache = new Map<string, number>();
    const idfOf = (term: string): number => {
      let value = idfCache.get(term);
      if (value === undefined) {
        value = this.idf(term);
        idfCache.set(term, value);
      }
      return value;
    };

    const results: Hit[] = [];
    for (const id of candidates) {
      const length = this.lengths.get(id) ?? 0;
      const norm = K1 * (1 - B + (B * length) / avg);
      let score = 0;
      const matched = new Set<string>();

      for (const group of expansions) {
        let best = 0;
        for (const term of group) {
          const positions = this.postings.get(term)?.get(id);
          if (!positions) continue;
          const tf = positions.length;
          best = Math.max(best, (idfOf(term) * tf * (K1 + 1)) / (tf + norm));
          matched.add(term);
        }
        score += best;
      }

      if (score > 0) {
        results.push({
          id,
          score: Number(score.toFixed(6)),
          metadata: { ...(this.documents.get(id)?.metadata ?? {}) },
          matchedTerms: [...matched].sort(),
        });
      }
    }

    results.sort((a, b) => (b.score === a.score ? a.id.localeCompare(b.id) : b.score - a.score));
    return results.slice(0, limit);
  }

  /** Documents where the terms appear consecutively, in order, with nothing between them. */
  phrase(phrase: string, limit = 10): Hit[] {
    const terms = tokenize(phrase ?? "");
    if (terms.length === 0) return [];
    if (terms.length === 1) return this.search(terms[0], { limit });

    const postingsFor = (term: string): Map<string, number[]> => this.postings.get(term) ?? new Map();
    const first = postingsFor(terms[0]);
    const rest = terms.slice(1).map(postingsFor);
    if (first.size === 0 || rest.some((p) => p.size === 0)) return [];

    const hits: Hit[] = [];
    for (const [id, positions] of first) {
      const allPresent = rest.every((byDoc) => byDoc.has(id));
      if (!allPresent) continue;

      const matched = terms.slice(1).map((t) => postingsFor(t).get(id)!);
      const consecutive = positions.some((start) =>
        matched.every((next, i) => next.includes(start + i + 1)),
      );
      if (!consecutive) continue;

      hits.push({
        id,
        score: terms.reduce((sum, term) => sum + this.idf(term), 0),
        metadata: { ...(this.documents.get(id)?.metadata ?? {}) },
        matchedTerms: [...terms].sort(),
      });
    }

    hits.sort((a, b) => (b.score === a.score ? a.id.localeCompare(b.id) : b.score - a.score));
    return hits.slice(0, limit);
  }

  document(id: string): Document | null {
    const doc = this.documents.get(id);
    return doc ? { ...doc, metadata: { ...(doc.metadata ?? {}) } } : null;
  }
}
