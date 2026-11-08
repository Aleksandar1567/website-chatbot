// The HTTP API: load a site, watch its progress, and chat with it.

import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { crawl, parseStartUrl } from './crawler.js';
import { UserError } from './errors.js';
import {
  buildChatRequest,
  createProfile,
  extractSources,
  parseProfile,
  retrievalQuery,
  sanitizeHistory,
} from './prompts.js';
import { createLlm, detectProvider, PROVIDERS } from './providers.js';
import { buildIndex, getEmbedder, search } from './rag.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const MAX_QUESTION_CHARS = 2000;
const MAX_CHUNKS = 1500;
const DEFAULT_MAX_PAGES = 60;
const MAX_PAGES_LIMIT = 300;
const TEMPORARY_FAILURES = new Set([429, 502, 503]);

export function createApp({
  env = {},
  crawlOptions = {},
  makeLlm = createLlm,
  loadEmbedder = getEmbedder,
  maxChunks = MAX_CHUNKS,
} = {}) {
  const app = express();
  const sites = new Map();
  const defaultMaxPages = crawlOptions.maxPages ?? DEFAULT_MAX_PAGES;

  function readMaxPages(value) {
    if (value === undefined || value === null || value === '') return defaultMaxPages;
    const pages = Number(value);
    if (!Number.isInteger(pages) || pages < 1 || pages > MAX_PAGES_LIMIT) {
      throw new UserError(`Broj stranica mora da bude između 1 i ${MAX_PAGES_LIMIT}.`);
    }
    return pages;
  }

  function resolveLlm({ apiKey, provider, model }) {
    const key = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (provider && (typeof provider !== 'string' || !Object.hasOwn(PROVIDERS, provider))) {
      throw new UserError('Taj provider nije podržan.');
    }
    if (key && !/^[\x21-\x7e]{8,512}$/.test(key)) throw new UserError('API ključ nije ispravnog formata.');

    let chosen = provider || (key ? detectProvider(key) : null);
    if (key && !chosen) {
      throw new UserError('Ne prepoznajem ovaj API ključ. Izaberi providera u delu Napredno.');
    }
    if (!key) {
      chosen ??= Object.keys(PROVIDERS).find((id) => env[PROVIDERS[id].envKey]);
      if (!chosen || !env[PROVIDERS[chosen].envKey]) throw new UserError('Unesi API ključ.');
    }

    const modelName = typeof model === 'string' ? model.trim() : '';
    if (modelName && !/^[\w.:/-]{1,100}$/.test(modelName)) throw new UserError('Naziv modela nije ispravan.');
    return makeLlm({
      provider: chosen,
      apiKey: key || env[PROVIDERS[chosen].envKey],
      model: modelName || undefined,
    });
  }

  function snapshot(site) {
    const { id, url, status, stage, pages, embedded, chunks, totalChunks, error, profile, llm } = site;
    return { id, url, status, stage, pages, embedded, chunks, totalChunks, error, profile, llm };
  }

  // The key is only in this job's arguments and is never stored on the site.
  async function buildSite(site, startUrl, maxPages, llm) {
    try {
      const pages = await crawl(startUrl, {
        ...crawlOptions,
        maxPages,
        onPage: (count) => {
          site.pages = count;
        },
      });
      site.stage = 'profile';
      try {
        site.profile = await createProfile(site.url, pages, llm);
      } catch (error) {
        // A busy model or a used-up quota shouldn't waste the pages already read, so
        // the bot starts without adapting to the site. A rejected key still stops here.
        if (!TEMPORARY_FAILURES.has(error.status)) throw error;
        site.profile = parseProfile('', site.url);
        site.profile.notice = `${error.message} Bot radi, ali se nije prilagodio sajtu.`;
      }

      site.stage = 'model';
      let embedder;
      try {
        embedder = await loadEmbedder();
      } catch {
        throw new UserError('Ne mogu da preuzmem model za pretragu. Proveri internet vezu.', 502);
      }

      site.stage = 'embed';
      site.index = await buildIndex(pages, {
        embedder,
        maxChunks,
        onProgress: (done, total) => {
          site.embedded = done;
          site.chunks = total;
        },
      });
      site.totalChunks = site.index.totalChunks;
      site.stage = 'ready';
      site.status = 'ready';
    } catch (error) {
      if (!(error instanceof UserError)) console.error('Site build failed:', error?.message);
      site.status = 'error';
      site.error = error instanceof UserError ? error.message : 'Nešto nije u redu sa čitanjem sajta.';
    }
  }

  // A web page in the browser must not be able to reach this local server by
  // pointing its own domain name at 127.0.0.1.
  app.use((req, res, next) => {
    if (!LOCAL_HOSTS.has(req.hostname)) return res.status(403).json({ error: 'Pristup je dozvoljen samo lokalno.' });
    next();
  });
  // The page holds an API key in memory, so it only runs its own scripts.
  app.use((_req, res, next) => {
    res.set('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.use(express.json());
  app.use(express.static(PUBLIC_DIR));

  app.get('/api/config', (_req, res) => {
    res.json({
      defaultMaxPages,
      maxPagesLimit: MAX_PAGES_LIMIT,
      providers: Object.entries(PROVIDERS).map(([id, { label, model, envKey }]) => ({
        id,
        label,
        model,
        hasEnvKey: Boolean(env[envKey]),
      })),
    });
  });

  app.post('/api/sites', (req, res) => {
    const body = req.body ?? {};
    const startUrl = parseStartUrl(body.url);
    const maxPages = readMaxPages(body.maxPages);
    const llm = resolveLlm(body);
    const id = createHash('sha256').update(`${maxPages}|${startUrl.href}`).digest('hex').slice(0, 16);

    let site = sites.get(id);
    if (!site || site.status === 'error') {
      site = {
        id,
        url: startUrl.href,
        status: 'loading',
        stage: 'crawl',
        pages: 0,
        embedded: 0,
        chunks: 0,
        llm: { provider: llm.provider, label: llm.label, model: llm.model },
      };
      sites.set(id, site);
      buildSite(site, startUrl, maxPages, llm);
    }
    res.status(202).json(snapshot(site));
  });

  app.get('/api/sites/:id', (req, res) => {
    const site = sites.get(req.params.id);
    if (!site) throw new UserError('Sajt nije učitan.', 404);
    res.json(snapshot(site));
  });

  app.post('/api/chat', async (req, res) => {
    const body = req.body ?? {};
    const site = sites.get(body.siteId);
    if (site?.status !== 'ready') throw new UserError('Sajt više nije učitan. Učitaj ga ponovo.', 404);

    const question = typeof body.message === 'string' ? body.message.trim() : '';
    if (!question) throw new UserError('Napiši pitanje.');
    if (question.length > MAX_QUESTION_CHARS) throw new UserError('Pitanje je predugačko.');

    const llm = resolveLlm(body);
    const history = sanitizeHistory(body.history);
    const chunks = await search(site.index, retrievalQuery(question, history));
    const reply = await llm.complete(
      buildChatRequest({ profile: site.profile, url: site.url, chunks, question, history }),
    );
    res.json({ reply, sources: extractSources(reply, chunks), llm: { label: llm.label, model: llm.model } });
  });

  app.use((error, _req, res, _next) => {
    if (error instanceof UserError) return res.status(error.status).json({ error: error.message });
    if (error?.status >= 400 && error?.status < 500) return res.status(error.status).json({ error: 'Neispravan zahtev.' });
    console.error('Request failed:', error?.message);
    res.status(500).json({ error: 'Nešto nije u redu na serveru.' });
  });

  return app;
}
