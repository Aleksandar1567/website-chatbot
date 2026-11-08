import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BM25,
  buildIndex,
  chunkPages,
  chunkText,
  mergeRankings,
  normalize,
  reciprocalRankFusion,
  search,
  tokenize,
} from '../lib/rag.js';

test('normalize makes diacritics, plain Latin and Serbian Cyrillic match', () => {
  assert.equal(normalize('Šta'), 'sta');
  assert.equal(normalize('ШТА'), 'sta');
  assert.equal(normalize('Đak'), 'djak');
  assert.equal(normalize('Љубљана'), normalize('Ljubljana'));
  assert.equal(normalize('Čačak'), normalize('Чачак'));
});

test('tokenize keeps letters and digits from any language', () => {
  assert.deepEqual(tokenize('Greška E4012: šta sad?'), ['greska', 'e4012', 'sta', 'sad']);
  assert.deepEqual(tokenize('...!'), []);
});

test('tokenize makes different endings of a word match, but keeps codes whole', () => {
  assert.deepEqual(tokenize('januarskom'), tokenize('јануара'));
  assert.deepEqual(tokenize('prijavim'), tokenize('пријаву'));
  assert.notDeepEqual(tokenize('13S111P1'), tokenize('13S111P2'));
  assert.deepEqual(tokenize('13S111PP1'), ['13s111pp1']);
});

test('chunkText keeps all text, respects the size and overlaps neighbors', () => {
  const sentences = Array.from({ length: 80 }, (_, i) => `Recenica broj ${i} ima nesto teksta.`);
  const chunks = chunkText(sentences.join(' '), 200, 40);
  assert.ok(chunks.length > 5);
  for (const chunk of chunks) assert.ok(chunk.length <= 240, `chunk too long: ${chunk.length}`);
  for (const sentence of sentences) assert.ok(chunks.some((chunk) => chunk.includes(sentence)), sentence);
  const firstEnd = chunks[0].slice(-20);
  assert.ok(chunks[1].includes(firstEnd), 'neighbors should overlap');
});

test('chunkText splits a very long sentence and handles empty text', () => {
  const chunks = chunkText('a'.repeat(1000), 300, 50);
  assert.ok(chunks.length >= 4);
  for (const chunk of chunks) assert.ok(chunk.length <= 350);
  assert.deepEqual(chunkText(''), []);
});

test('chunkPages drops boilerplate repeated across pages', () => {
  const chunks = chunkPages([
    { title: 'A', url: 'https://x/a', text: 'Isti tekst na svakoj stranici.' },
    { title: 'B', url: 'https://x/b', text: 'Isti tekst na svakoj stranici.' },
    { title: 'C', url: 'https://x/c', text: 'Drugi tekst.' },
  ]);
  assert.deepEqual(chunks.map((chunk) => chunk.url), ['https://x/a', 'https://x/c']);
});

test('BM25 finds an exact code and returns nothing for unknown words', () => {
  const bm25 = new BM25(['Greska E4012 znaci los sertifikat', 'Baterija traje cetiri sata', 'Uredjaj se pregreva']);
  assert.equal(bm25.search('E4012', 5)[0].index, 0);
  assert.equal(bm25.search('e4012', 5).length, 1);
  assert.deepEqual(bm25.search('kvantna fizika', 5), []);
});

test('BM25 matches a query typed without diacritics', () => {
  const bm25 = new BM25(['Školarina iznosi 200000 dinara', 'Prijava ispita']);
  assert.equal(bm25.search('skolarina', 5)[0].index, 0);
});

test('BM25 gives a rare word more weight than a common one', () => {
  const texts = Array.from({ length: 20 }, (_, i) => `the document number ${i} about the topic`);
  texts.push('the overheating protection document');
  const hits = new BM25(texts).search('the overheating', 30);
  assert.equal(hits[0].index, 20);
  assert.equal(hits.length, 21);
});

test('BM25 finds a Latin query in Cyrillic text', () => {
  const bm25 = new BM25(['13С111П1 - Програмирање 1', 'Школарина и ценовник']);
  assert.equal(bm25.search('13S111P1', 5)[0].index, 0);
  assert.equal(bm25.search('skolarina', 5)[0].index, 1);
});

test('BM25 finds a question with other word endings and ignores very short words', () => {
  const bm25 = new BM25(['Rok za prijavu ispita je do 18. januara', 'Da li je do u da na i do da u na']);
  const hits = bm25.search('do kada mogu da prijavim ispit u januarskom roku', 5);
  assert.deepEqual(hits.map((hit) => hit.index), [0]);
  // A question made only of short words still searches.
  assert.ok(bm25.search('da li', 5).length > 0);
});

test('mergeRankings keeps a top hit that fusion alone would bury', () => {
  const inBoth = ['a', 'b', 'c', 'd', 'e', 'f'];
  const keyword = [...inBoth];
  const vector = ['best', ...inBoth];
  assert.ok(!reciprocalRankFusion([keyword, vector]).slice(0, 3).some(([id]) => id === 'best'));
  assert.ok(mergeRankings([keyword, vector], 3, 1).includes('best'));
  assert.ok(mergeRankings([keyword, vector], 4, 3).includes('best'));
});

test('mergeRankings fills up to k without repeats, and handles short lists', () => {
  assert.deepEqual(mergeRankings([['a', 'b'], ['a', 'c']], 3, 1), ['a', 'b', 'c']);
  assert.equal(mergeRankings([['a', 'b', 'c', 'd'], ['e', 'f', 'g', 'h']], 2).length, 2);
  assert.deepEqual(mergeRankings([[], ['a']], 8), ['a']);
  assert.deepEqual(mergeRankings([[], []], 8), []);
});

test('reciprocalRankFusion prefers a document that both rankings found', () => {
  const fused = reciprocalRankFusion([['a', 'b'], ['c', 'b']], 1);
  assert.equal(fused[0][0], 'b');
  assert.deepEqual(new Set(fused.map(([id]) => id)), new Set(['a', 'b', 'c']));
  assert.deepEqual(reciprocalRankFusion([['a']], 60), [['a', 1 / 61]]);
  assert.deepEqual(reciprocalRankFusion([[], []]), []);
});

const fakeEmbedder = {
  // Gives each text a one-hot vector based on a keyword, so results are predictable.
  vector(text) {
    return ['battery', 'heat', 'exam'].map((word) => (text.toLowerCase().includes(word) ? 1 : 0));
  },
  async passages(texts) {
    return texts.map((text) => this.vector(text));
  },
  async query(text) {
    return this.vector(text);
  },
};

test('buildIndex reports progress and search merges both retrievers', async () => {
  const pages = [
    { title: 'Battery', url: 'https://x/battery', text: 'The battery lasts four hours.' },
    { title: 'Codes', url: 'https://x/codes', text: 'Code E4012 means a bad certificate.' },
  ];
  const progress = [];
  const index = await buildIndex(pages, {
    embedder: fakeEmbedder,
    batchSize: 1,
    onProgress: (done, total) => progress.push([done, total]),
  });
  assert.deepEqual(progress, [[1, 2], [2, 2]]);
  assert.equal(index.totalChunks, 2);

  const hits = await search(index, 'E4012 battery', { k: 2 });
  assert.deepEqual(new Set(hits.map((chunk) => chunk.url)), new Set(['https://x/battery', 'https://x/codes']));
});

test('buildIndex caps the number of chunks and reports the real total', async () => {
  const pages = Array.from({ length: 5 }, (_, i) => ({ title: `P${i}`, url: `https://x/${i}`, text: `Tekst broj ${i}.` }));
  const index = await buildIndex(pages, { embedder: fakeEmbedder, maxChunks: 2 });
  assert.equal(index.chunks.length, 2);
  assert.equal(index.totalChunks, 5);
});
