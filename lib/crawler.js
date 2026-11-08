// Reads a website, page by page, starting from one URL and staying on that site.

import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import * as cheerio from 'cheerio';
import robotsParser from 'robots-parser';
import { UserError } from './errors.js';

const USER_AGENT = 'website-chatbot/2.0 (learning project)';
const TIMEOUT_MS = 15_000;
const MAX_PAGE_BYTES = 3 * 1024 * 1024; // Longer pages are cut off at this size.
const MAX_REDIRECTS = 5;
const MAX_CRAWL_DELAY_MS = 5_000;
const MIN_PAGE_CHARS = 30;
const MIN_SITE_CHARS = 200;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const NON_PAGE_FILE =
  /\.(pdf|jpe?g|png|gif|webp|svg|ico|zip|rar|gz|docx?|pptx?|xlsx?|csv|mp3|mp4|webm|avi|css|js|json|xml)$/i;
const NOISE =
  'script, style, noscript, iframe, svg, template, nav, aside, [hidden], [aria-hidden="true"], ' +
  '[role="navigation"], [role="banner"], [role="contentinfo"]';
const BLOCKS = 'p, div, li, ul, ol, h1, h2, h3, h4, h5, h6, td, th, tr, br, section, article, blockquote, pre';

// The crawler fetches URLs it is given, so it must not be pointed at this
// machine or the local network, including through a redirect or a link.
const privateAddresses = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) {
  privateAddresses.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
]) {
  privateAddresses.addSubnet(address, prefix, 'ipv6');
}

export function parseStartUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new UserError('Unesi adresu sajta.');

  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new UserError('Adresa sajta nije ispravna.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new UserError('Podržane su samo http i https adrese.');
  }
  url.username = '';
  url.password = '';
  url.hash = '';
  return url;
}

export async function assertPublicHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  const family = isIP(host);
  const addresses = family ? [{ address: host, family }] : await lookup(host, { all: true });
  for (const { address, family: version } of addresses) {
    if (privateAddresses.check(address, version === 6 ? 'ipv6' : 'ipv4')) {
      throw new UserError('Adrese iz lokalne mreže nisu dozvoljene.');
    }
  }
}

function siteOf(hostname) {
  return hostname.toLowerCase().replace(/^www\./, '');
}

function pageKey(url) {
  return `${siteOf(url.hostname)}${url.pathname.replace(/\/+$/, '')}${url.search}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchFollowingRedirects(start, context, beforeHop = async () => {}) {
  let url = new URL(start);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new UserError('Sajt preusmerava na adresu koja nije podržana.');
    }
    if (!context.allowPrivate) await assertPublicHost(url.hostname);
    await beforeHop(url);

    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
    });
    if (!REDIRECT_CODES.has(response.status)) return { response, url };

    await response.body?.cancel();
    const location = response.headers.get('location');
    if (!location) throw new UserError('Sajt je vratio neispravno preusmeravanje.');
    url = new URL(location, url);
  }
  throw new UserError('Sajt ima previše preusmeravanja.');
}

async function readBody(response) {
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  while (size < MAX_PAGE_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    size += value.length;
  }
  await reader.cancel();
  return decode(Buffer.concat(parts).subarray(0, MAX_PAGE_BYTES), response.headers.get('content-type'));
}

function decode(bytes, contentType) {
  const charsetPattern = /charset=["']?([\w-]+)/i;
  const head = bytes.subarray(0, 2048).toString('latin1');
  const charset = charsetPattern.exec(contentType ?? '')?.[1] ?? charsetPattern.exec(head)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

function robotsFor(origin, context) {
  if (!context.robots.has(origin)) context.robots.set(origin, loadRobots(origin, context));
  return context.robots.get(origin);
}

async function loadRobots(origin, context) {
  const robotsUrl = `${origin}/robots.txt`;
  let text = '';
  try {
    const { response } = await fetchFollowingRedirects(robotsUrl, context);
    if (response.ok) text = await readBody(response);
    else await response.body?.cancel();
  } catch {
    // A missing or unreachable robots.txt doesn't restrict anything.
  }
  return robotsParser(robotsUrl, text);
}

function extractPage(html) {
  const $ = cheerio.load(html);
  // Links are collected first, because the navigation is removed below.
  const hrefs = (selector) =>
    $(selector)
      .map((_, element) => $(element).attr('href'))
      .get();
  const links = hrefs('a[href]');
  const menuLinks = hrefs('nav a[href], header a[href], aside a[href], [role="navigation"] a[href]');
  const title = $('title').first().text().trim();
  const description = $('meta[name="description"]').attr('content')?.trim() ?? '';

  $(NOISE).remove();
  $('header, footer')
    .filter((_, element) => $(element).closest('article, main').length === 0)
    .remove();
  $(BLOCKS).append(' ');

  const clean = (selection) => selection.text().replace(/\s+/g, ' ').trim();
  const main = clean($('main, [role="main"]').first());
  return { title, description, links, menuLinks, text: main.length >= MIN_SITE_CHARS ? main : clean($('body')) };
}

async function fetchPage(target, context, site) {
  const { response, url } = await fetchFollowingRedirects(target, context, async (hop) => {
    if (site && siteOf(hop.hostname) !== site) {
      throw new UserError('Stranica preusmerava na drugi sajt.');
    }
    const robots = await robotsFor(hop.origin, context);
    if (robots.isAllowed(hop.href, USER_AGENT) === false) {
      throw new UserError('Sajt u robots.txt fajlu ne dozvoljava čitanje ove stranice.');
    }
  });

  if (!response.ok) {
    await response.body?.cancel();
    const error = new UserError(`Sajt je vratio grešku (HTTP ${response.status}).`);
    error.stopCrawling = response.status === 429;
    throw error;
  }
  if (!/html/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel();
    throw new UserError('Ova adresa nije HTML stranica.');
  }
  return { url, ...extractPage(await readBody(response)) };
}

function linkTargets(links, baseUrl, site) {
  const targets = [];
  for (const href of links) {
    let url;
    try {
      url = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if (!['http:', 'https:'].includes(url.protocol)) continue;
    if (siteOf(url.hostname) !== site || NON_PAGE_FILE.test(url.pathname)) continue;
    url.hash = '';
    url.search = '';
    targets.push(url);
  }
  return targets;
}

function describeStartFailure(error) {
  if (error instanceof UserError) return error;
  if (error?.name === 'TimeoutError') return new UserError('Sajt se predugo učitava.');
  return new UserError('Ne mogu da učitam sajt. Proveri adresu.');
}

/**
 * Returns the site's pages as { url, title, description, text }. Pages under the
 * start URL's folder come before the rest of the site. Within each group, menu
 * links come first: they lead to a site's lasting content, while links in the
 * page body are often news that would use up the page limit.
 */
export async function crawl(start, { maxPages = 60, delayMs = 200, allowPrivate = false, onPage = () => {} } = {}) {
  const startUrl = start instanceof URL ? start : parseStartUrl(start);
  const context = { allowPrivate, robots: new Map() };
  const queues = [[startUrl], [], [], []]; // near menu, near body, far menu, far body
  const seen = new Set([pageKey(startUrl)]);
  const contents = new Set();
  const pages = [];
  let site = null;
  let basePath = '/';

  while (pages.length < maxPages && queues.some((queue) => queue.length > 0)) {
    const target = queues.find((queue) => queue.length > 0).shift();
    let page;
    try {
      page = await fetchPage(target, context, site);
    } catch (error) {
      if (site === null) throw describeStartFailure(error);
      if (error.stopCrawling) break;
      continue;
    }

    if (site === null) {
      site = siteOf(page.url.hostname);
      basePath = page.url.pathname.slice(0, page.url.pathname.lastIndexOf('/') + 1);
    }
    seen.add(pageKey(page.url));

    if (page.text.length >= MIN_PAGE_CHARS && !contents.has(page.text)) {
      contents.add(page.text);
      pages.push({
        url: page.url.href,
        title: page.title || page.url.href,
        description: page.description,
        text: page.text,
      });
      onPage(pages.length);
    }

    for (const [links, isMenu] of [[page.menuLinks, true], [page.links, false]]) {
      for (const link of linkTargets(links, page.url, site)) {
        const key = pageKey(link);
        if (seen.has(key)) continue;
        seen.add(key);
        queues[(link.pathname.startsWith(basePath) ? 0 : 2) + (isMenu ? 0 : 1)].push(link);
      }
    }

    const robots = await robotsFor(page.url.origin, context);
    const crawlDelayMs = (Number(robots.getCrawlDelay(USER_AGENT)) || 0) * 1000;
    await sleep(Math.max(delayMs, Math.min(crawlDelayMs, MAX_CRAWL_DELAY_MS)));
  }

  if (pages.reduce((sum, page) => sum + page.text.length, 0) < MIN_SITE_CHARS) {
    throw new UserError(
      'Na ovom sajtu ima premalo teksta. Možda se njegov sadržaj učitava preko JavaScript-a, što ovaj bot ne može da pročita.',
    );
  }
  return pages;
}
