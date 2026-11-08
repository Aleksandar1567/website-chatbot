// Runs the whole API against a small local website, with fakes for the model and
// the embedder.

import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createApp } from '../lib/app.js';
import { UserError } from '../lib/errors.js';

const KEY = 'sk-ant-secret-test-key';
const TEXT = 'Upis na fakultet traje dve nedelje i radi se preko portala za studente. '.repeat(4);

let website;
let websiteUrl;
let websiteHits;
let api;
let apiUrl;
let llmCalls;
let llmConfigs;
let llmError;

const fakeLlm = (config) => {
  llmConfigs.push(config);
  return {
    provider: config.provider,
    label: config.provider,
    model: config.model ?? 'default-model',
    async complete(request) {
      if (llmError) throw llmError;
      llmCalls.push(request);
      if (request.system.includes('study a website')) {
        return JSON.stringify({
          name: 'Test Fakultet',
          summary: 'Sajt fakulteta.',
          tone: 'Ljubazno.',
          welcome: 'Dobrodošli!',
          suggestions: ['Kako traje upis?'],
        });
      }
      return 'Upis traje dve nedelje [1].';
    },
  };
};

const fakeEmbedder = {
  async passages(texts) {
    return texts.map(() => [1, 0]);
  },
  async query() {
    return [1, 0];
  },
};

const post = (path, body, headers = {}) =>
  fetch(`${apiUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

async function waitForSite(id) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const site = await (await fetch(`${apiUrl}/api/sites/${id}`)).json();
    if (site.status !== 'loading') return site;
    await sleep(10);
  }
  throw new Error('Site did not finish loading');
}

function startApi(options) {
  const app = createApp({
    crawlOptions: { allowPrivate: true, delayMs: 0 },
    makeLlm: fakeLlm,
    loadEmbedder: async () => fakeEmbedder,
    ...options,
  });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

before(async () => {
  website = http.createServer((req, res) => {
    websiteHits.push(req.url);
    if (req.url === '/robots.txt') return res.writeHead(404).end();
    if (req.url.startsWith('/prazno')) return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<p>x</p>');
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<title>Upis</title><main><p>${TEXT}</p></main>`);
  });
  await new Promise((resolve) => website.listen(0, '127.0.0.1', resolve));
  websiteUrl = `http://127.0.0.1:${website.address().port}/`;
  api = await startApi();
  apiUrl = `http://127.0.0.1:${api.address().port}`;
});

after(() => {
  for (const server of [website, api]) {
    server.closeAllConnections();
    server.close();
  }
});

beforeEach(() => {
  websiteHits = [];
  llmCalls = [];
  llmConfigs = [];
  llmError = null;
});

test('a site goes from URL and key to a chatbot that cites its sources', async () => {
  const created = await post('/api/sites', { url: `${websiteUrl}?flow=1`, apiKey: KEY });
  assert.equal(created.status, 202);
  const { id } = await created.json();

  const site = await waitForSite(id);
  assert.equal(site.status, 'ready', site.error);
  assert.equal(site.profile.name, 'Test Fakultet');
  assert.equal(site.profile.welcome, 'Dobrodošli!');
  assert.deepEqual(site.profile.suggestions, ['Kako traje upis?']);
  assert.equal(site.pages, 1);
  assert.ok(site.chunks >= 1);
  assert.equal(site.llm.provider, 'anthropic');
  assert.equal(llmConfigs[0].apiKey, KEY);
  assert.ok(!JSON.stringify(site).includes(KEY), 'the key must never come back from the API');

  const response = await post('/api/chat', {
    siteId: id,
    message: 'Koliko traje upis?',
    apiKey: KEY,
    history: [
      { role: 'user', content: 'Zdravo' },
      { role: 'assistant', content: 'Zdravo!' },
    ],
  });
  assert.equal(response.status, 200);
  const chat = await response.json();
  assert.equal(chat.reply, 'Upis traje dve nedelje [1].');
  assert.equal(chat.sources.length, 1);
  assert.ok(chat.sources[0].url.startsWith(websiteUrl));
  assert.deepEqual(chat.sources[0].refs, [1]);
  assert.ok(!JSON.stringify(chat).includes(KEY));

  const request = llmCalls.at(-1);
  assert.match(request.system, /Sajt fakulteta\./);
  assert.equal(request.messages.length, 3);
  assert.match(request.messages[2].content, /Upis na fakultet/);
  assert.match(request.messages[2].content, /Koliko traje upis\?/);
});

test('loading the same site again reuses it', async () => {
  const url = `${websiteUrl}?reuse=1`;
  const { id } = await (await post('/api/sites', { url, apiKey: KEY })).json();
  await waitForSite(id);
  const hits = websiteHits.length;
  const again = await (await post('/api/sites', { url, apiKey: KEY })).json();
  assert.equal(again.id, id);
  assert.equal(again.status, 'ready');
  assert.equal(websiteHits.length, hits);
});

test('a failed site reports why and can be tried again', async () => {
  const url = `${websiteUrl}prazno`;
  const { id } = await (await post('/api/sites', { url, apiKey: KEY })).json();
  const failed = await waitForSite(id);
  assert.equal(failed.status, 'error');
  assert.match(failed.error, /premalo teksta/);

  const again = await (await post('/api/sites', { url, apiKey: KEY })).json();
  assert.equal(again.status, 'loading');
  await waitForSite(id);
});

test('a rejected key stops loading with a clear message', async () => {
  llmError = new UserError('Claude nije prihvatio API ključ.', 401);
  const { id } = await (await post('/api/sites', { url: `${websiteUrl}?badkey=1`, apiKey: KEY })).json();
  const site = await waitForSite(id);
  assert.equal(site.status, 'error');
  assert.match(site.error, /API ključ/);
});

test('a used-up quota still gives a working bot that says it did not adapt', async () => {
  llmError = new UserError('Gemini javlja da je dostignut limit.', 429);
  const { id } = await (await post('/api/sites', { url: `${websiteUrl}?quota=1`, apiKey: KEY })).json();
  const site = await waitForSite(id);
  assert.equal(site.status, 'ready', site.error);
  assert.match(site.profile.notice, /dostignut limit.*nije prilagodio/);
  assert.equal(site.profile.name, '127.0.0.1');
  assert.ok(site.chunks >= 1);

  // Once the model is available again, the same bot answers.
  llmError = null;
  const chat = await post('/api/chat', { siteId: id, message: 'Koliko traje upis?', apiKey: KEY });
  assert.equal(chat.status, 200);
  assert.equal((await chat.json()).sources.length, 1);
});

test('an unexpected failure does not expose internal details', async () => {
  llmError = new Error(`internal detail ${KEY}`);
  const { id } = await (await post('/api/sites', { url: `${websiteUrl}?boom=1`, apiKey: KEY })).json();
  const site = await waitForSite(id);
  assert.equal(site.status, 'error');
  assert.ok(!site.error.includes('internal detail'));
});

test('sites and chat reject bad input', async () => {
  const noKey = await post('/api/sites', { url: websiteUrl });
  assert.equal(noKey.status, 400);
  assert.match((await noKey.json()).error, /API ključ/);

  const cases = [
    [{ apiKey: KEY }, /adresu/],
    [{ url: 'file:///etc/passwd', apiKey: KEY }, /http/],
    [{ url: websiteUrl, apiKey: 'nepoznat-format-kljuca' }, /Ne prepoznajem/],
    [{ url: websiteUrl, apiKey: 'kratak' }, /formata/],
    [{ url: websiteUrl, apiKey: `${KEY}\nX: y` }, /formata/],
    [{ url: websiteUrl, apiKey: KEY, provider: '__proto__' }, /provider/],
    [{ url: websiteUrl, apiKey: KEY, provider: ['openai'] }, /provider/],
    [{ url: websiteUrl, apiKey: KEY, model: 'bad model!' }, /modela/],
    [{ url: websiteUrl, apiKey: KEY, maxPages: 0 }, /stranica/],
    [{ url: websiteUrl, apiKey: KEY, maxPages: 301 }, /stranica/],
    [{ url: websiteUrl, apiKey: KEY, maxPages: 1.5 }, /stranica/],
    [{ url: websiteUrl, apiKey: KEY, maxPages: 'mnogo' }, /stranica/],
  ];
  for (const [body, message] of cases) {
    const response = await post('/api/sites', body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.match((await response.json()).error, message);
  }

  const { id } = await (await post('/api/sites', { url: `${websiteUrl}?input=1`, apiKey: KEY })).json();
  await waitForSite(id);
  for (const [body, status] of [
    [{ siteId: 'nema', message: 'x', apiKey: KEY }, 404],
    [{ message: 'x', apiKey: KEY }, 404],
    [{ siteId: id, message: '   ', apiKey: KEY }, 400],
    [{ siteId: id, message: 42, apiKey: KEY }, 400],
    [{ siteId: id, message: 'x'.repeat(2001), apiKey: KEY }, 400],
    [{ siteId: id, message: 'x' }, 400],
  ]) {
    assert.equal((await post('/api/chat', body)).status, status, JSON.stringify(body).slice(0, 60));
  }

  assert.equal((await post('/api/chat', '{ neispravan json')).status, 400);
  assert.equal((await fetch(`${apiUrl}/api/sites/nema`)).status, 404);
});

test('the provider and model chosen in the form are used', async () => {
  const { id, llm } = await (
    await post('/api/sites', {
      url: `${websiteUrl}?choice=1`,
      apiKey: 'custom-key-format',
      provider: 'openai',
      model: 'gpt-custom',
    })
  ).json();
  assert.equal(llm.provider, 'openai');
  assert.equal(llm.model, 'gpt-custom');
  await waitForSite(id);
});

test('a different page limit builds a separate bot and respects the limit', async () => {
  const url = `${websiteUrl}?limit=1`;
  const first = await (await post('/api/sites', { url, apiKey: KEY, maxPages: 1 })).json();
  const second = await (await post('/api/sites', { url, apiKey: KEY, maxPages: 2 })).json();
  assert.notEqual(first.id, second.id);
  assert.equal((await waitForSite(first.id)).pages, 1);
  await waitForSite(second.id);

  const config = await (await fetch(`${apiUrl}/api/config`)).json();
  assert.equal(config.defaultMaxPages, 60);
  assert.equal(config.maxPagesLimit, 300);
});

test('without a pasted key the first key in .env is used, and only that source', async () => {
  const server = await startApi({ env: { OPENAI_API_KEY: 'sk-from-env-file', ANTHROPIC_API_KEY: 'sk-ant-from-env-file' } });
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const config = await (await fetch(`${url}/api/config`)).json();
    const flags = Object.fromEntries(config.providers.map((provider) => [provider.id, provider.hasEnvKey]));
    assert.deepEqual(flags, { gemini: false, anthropic: true, openai: true });
    assert.ok(!JSON.stringify(config).includes('from-env-file'));

    const send = (body) =>
      fetch(`${url}/api/sites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    await send({ url: `${websiteUrl}?env=1` });
    assert.equal(llmConfigs.at(-1).provider, 'anthropic');
    assert.equal(llmConfigs.at(-1).apiKey, 'sk-ant-from-env-file');

    await send({ url: `${websiteUrl}?env=2`, provider: 'openai' });
    assert.equal(llmConfigs.at(-1).apiKey, 'sk-from-env-file');

    const missing = await send({ url: `${websiteUrl}?env=3`, provider: 'gemini' });
    assert.equal(missing.status, 400);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('requests for another host name are refused and the page gets safety headers', async () => {
  const port = api.address().port;
  const status = await new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: '/api/config', headers: { Host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      })
      .on('error', reject);
  });
  assert.equal(status, 403);

  const page = await fetch(`${apiUrl}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
});
