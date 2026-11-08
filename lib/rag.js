// Hybrid retrieval: BM25 keyword search and local embeddings, merged with
// Reciprocal Rank Fusion. Embeddings run on this machine, so retrieval works the
// same with any provider and indexing a site doesn't use the API key.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EMBEDDING_MODEL = 'Xenova/multilingual-e5-small';
const MODEL_CACHE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.cache', 'models');
const STEM_LENGTH = 6;
const KEEP_TOP = 3;

const CYRILLIC = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', ђ: 'dj', е: 'e', ж: 'z', з: 'z', и: 'i',
  ј: 'j', к: 'k', л: 'l', љ: 'lj', м: 'm', н: 'n', њ: 'nj', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', ћ: 'c', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'c', џ: 'dz', ш: 's',
};

/** Makes "Šta", "sta" and "Шта" match, because people type all three. */
export function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[Ѐ-ӿ]/g, (letter) => CYRILLIC[letter] ?? letter)
    .replace(/đ/g, 'dj')
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
}

/**
 * Cuts long words to their start, so that word endings don't matter: "januarskom"
 * and "januara" both become "januar". Codes like 13S111P1 are left whole.
 */
function stem(token) {
  return token.length > STEM_LENGTH && /^\p{L}+$/u.test(token) ? token.slice(0, STEM_LENGTH) : token;
}

export function tokenize(text) {
  return (normalize(text).match(/[\p{L}\p{N}]+/gu) ?? []).map(stem);
}

/** Words of one or two letters are mostly function words, like "do", "da" and "of". */
function queryTerms(query) {
  const terms = [...new Set(tokenize(query))];
  const meaningful = terms.filter((term) => term.length > 2 || /\d/.test(term));
  return meaningful.length > 0 ? meaningful : terms;
}

/** Splits text at sentence ends into pieces of about `size` characters that overlap. */
export function chunkText(text, size = 900, overlap = 150) {
  const pieces = (text.match(/[^.!?]+[.!?]*\s*/g) ?? []).flatMap((sentence) => {
    if (sentence.length <= size) return [sentence];
    const parts = [];
    for (let start = 0; start < sentence.length; start += size) parts.push(sentence.slice(start, start + size));
    return parts;
  });

  const chunks = [];
  let current = '';
  for (const piece of pieces) {
    if (current && current.length + piece.length > size) {
      chunks.push(current.trim());
      const tail = current.slice(-overlap);
      current = tail.slice(tail.indexOf(' ') + 1);
    }
    current += piece;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

export function chunkPages(pages) {
  const seen = new Set();
  const chunks = [];
  for (const page of pages) {
    for (const text of chunkText(page.text)) {
      // Boilerplate repeated across pages would crowd out real results.
      if (seen.has(text)) continue;
      seen.add(text);
      chunks.push({ title: page.title, url: page.url, text });
    }
  }
  return chunks;
}

export class BM25 {
  constructor(texts, { k1 = 1.5, b = 0.75 } = {}) {
    this.k1 = k1;
    this.b = b;
    this.count = texts.length;
    this.lengths = [];
    this.postings = new Map();

    texts.forEach((text, doc) => {
      const tokens = tokenize(text);
      this.lengths.push(tokens.length);
      const frequencies = new Map();
      for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
      for (const [term, frequency] of frequencies) {
        if (!this.postings.has(term)) this.postings.set(term, []);
        this.postings.get(term).push([doc, frequency]);
      }
    });
    this.averageLength = this.lengths.reduce((sum, length) => sum + length, 0) / (this.count || 1) || 1;
  }

  search(query, k) {
    const scores = new Map();
    for (const term of queryTerms(query)) {
      const postings = this.postings.get(term);
      if (!postings) continue;
      const idf = Math.log(1 + (this.count - postings.length + 0.5) / (postings.length + 0.5));
      for (const [doc, frequency] of postings) {
        const lengthNorm = 1 - this.b + (this.b * this.lengths[doc]) / this.averageLength;
        const score = (idf * frequency * (this.k1 + 1)) / (frequency + this.k1 * lengthNorm);
        scores.set(doc, (scores.get(doc) ?? 0) + score);
      }
    }
    return [...scores]
      .sort((first, second) => second[1] - first[1])
      .slice(0, k)
      .map(([index, score]) => ({ index, score }));
  }
}

/** Merges rankings by position: score(doc) = sum of 1 / (k + rank). */
export function reciprocalRankFusion(rankings, k = 60) {
  const scores = new Map();
  for (const ranking of rankings) {
    ranking.forEach((id, position) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + position + 1));
    });
  }
  return [...scores].sort((first, second) => second[1] - first[1]);
}

/**
 * RRF favors documents found by both lists, which can bury the best hit of just
 * one of them. So each list's top results always stay in, and RRF fills the rest.
 */
export function mergeRankings(rankings, k, keepTop = KEEP_TOP) {
  const merged = new Set();
  for (let position = 0; position < keepTop; position++) {
    for (const ranking of rankings) {
      if (position < ranking.length) merged.add(ranking[position]);
    }
  }
  for (const [id] of reciprocalRankFusion(rankings)) {
    if (merged.size >= k) break;
    merged.add(id);
  }
  return [...merged].slice(0, k);
}

async function loadEmbedder() {
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = MODEL_CACHE;
  const extractor = await pipeline('feature-extraction', EMBEDDING_MODEL, { dtype: 'q8' });
  const embed = async (texts) => (await extractor(texts, { pooling: 'mean', normalize: true })).tolist();
  return {
    // This model family expects these two prefixes.
    passages: (texts) => embed(texts.map((text) => `passage: ${text}`)),
    query: async (text) => (await embed([`query: ${text}`]))[0],
  };
}

let embedderPromise = null;

export function getEmbedder() {
  embedderPromise ??= loadEmbedder().catch((error) => {
    embedderPromise = null;
    throw error;
  });
  return embedderPromise;
}

function searchText(chunk) {
  return `${chunk.title}. ${chunk.text}`;
}

export async function buildIndex(pages, { embedder, maxChunks = 1500, batchSize = 32, onProgress = () => {} }) {
  const allChunks = chunkPages(pages);
  const chunks = allChunks.slice(0, maxChunks);
  const texts = chunks.map(searchText);

  const vectors = [];
  for (let start = 0; start < texts.length; start += batchSize) {
    vectors.push(...(await embedder.passages(texts.slice(start, start + batchSize))));
    onProgress(vectors.length, texts.length);
  }
  return { chunks, vectors, embedder, bm25: new BM25(texts), totalChunks: allChunks.length };
}

function dot(first, second) {
  let sum = 0;
  for (let i = 0; i < first.length; i++) sum += first[i] * second[i];
  return sum;
}

export async function search(index, query, { k = 8, candidates = 30 } = {}) {
  const keywordRanking = index.bm25.search(query, candidates).map((hit) => hit.index);
  const queryVector = await index.embedder.query(query);
  const vectorRanking = index.vectors
    .map((vector, i) => [i, dot(vector, queryVector)])
    .sort((first, second) => second[1] - first[1])
    .slice(0, candidates)
    .map(([i]) => i);

  return mergeRankings([keywordRanking, vectorRanking], k).map((i) => index.chunks[i]);
}
