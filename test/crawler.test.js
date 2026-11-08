import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { assertPublicHost, crawl, parseStartUrl } from '../lib/crawler.js';
import { UserError } from '../lib/errors.js';

const LONG = 'Ovo je dovoljno dugačak pasus teksta da ga crawler sačuva kao pravi sadržaj stranice. '.repeat(4);
const requests = [];
let server;
let base;

function html(body, title = 'Naslov') {
  return `<!doctype html><html><head><title>${title}</title>
    <meta name="description" content="Opis sajta"><script>var secret = "SCRIPT_TEXT";</script></head>
    <body>${body}</body></html>`;
}

const ROUTES = {
  '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nDisallow: /zabranjeno\n' },
  '/': {
    body: html(`<header><a href="/header-link">Meni</a></header>
      <nav><a href="/o-nama">O nama</a><a href="/docs/a">Docs</a><a href="/zabranjeno">X</a>
      <a href="/kopija">Kopija</a><a href="/fajl.pdf">PDF</a><a href="/slika">Slika</a>
      <a href="/van">Van</a><a href="/ne-postoji">404</a><a href="mailto:a@b.c">Mail</a>
      <a href="javascript:alert(1)">JS</a><a href="http://drugi-sajt.example/x">Drugi</a>
      <a href="/o-nama#deo">Isto</a><a href="/o-nama?utm=1">Isto opet</a></nav>
      <main><h1>Glavna</h1><p>${LONG}</p><p>Prvi</p><p>Drugi</p></main>
      <footer>Footer tekst</footer>`, 'Pocetna'),
  },
  '/header-link': { body: html(`<p>Stranica iz menija. ${LONG}</p>`) },
  '/o-nama': { body: html(`<p>O nama. ${LONG}</p><a href="/">Nazad</a>`, 'O nama') },
  '/kopija': { body: html(`<p>O nama. ${LONG}</p><a href="/">Nazad</a>`, 'Kopija') },
  '/docs/a': { body: html(`<p>Dokumentacija A. ${LONG}</p><a href="b">B</a>`) },
  '/docs/b': { body: html(`<p>Dokumentacija B. ${LONG}</p><a href="/o-nama">O nama</a>`) },
  '/zabranjeno': { body: html(`<p>TAJNA ${LONG}</p>`) },
  '/fajl.pdf': { type: 'application/pdf', body: 'PDF_TEXT' },
  '/slika': { type: 'image/png', body: 'PNG_TEXT' },
  '/samo-js': { body: html('<div id="app"></div><script src="/app.js"></script>') },
  '/samo-js-sa-linkom': { body: html(`<a href="/o-nama">O nama</a>`) },
  '/cp1250': {
    type: 'text/html; charset=windows-1250',
    body: Buffer.concat([
      Buffer.from('<html><body><p>'),
      Buffer.from([0x9a, 0x9e, 0xe8, 0xe6, 0xf0]), // šžčćđ
      Buffer.from(`</p><p>${LONG}</p></body></html>`),
    ]),
  },
  '/vesti-start': {
    body: html(`<main><p>Početna. ${LONG}</p><a href="/vest-1">Vest</a><a href="/vest-2">Vest</a></main>
      <nav><a href="/sekcija">Sekcija</a></nav>`),
  },
  '/vest-1': { body: html(`<p>Prva vest. ${LONG}</p>`) },
  '/vest-2': { body: html(`<p>Druga vest. ${LONG}</p>`) },
  '/sekcija': { body: html(`<nav><a href="/rokovi">Rokovi</a></nav><p>Sekcija. ${LONG}</p>`) },
  '/rokovi': { body: html(`<p>Rokovi za prijavu. ${LONG}</p>`) },
  '/rate-limit-start': { body: html(`<p>Start. ${LONG}</p><a href="/limit">L</a><a href="/posle-limita">P</a>`) },
  '/posle-limita': { body: html(`<p>Posle limita. ${LONG}</p>`) },
};

before(async () => {
  server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    requests.push(pathname);
    if (pathname === '/van') {
      const port = server.address().port;
      res.writeHead(302, { Location: `http://127.0.0.2:${port}/tudje` }).end();
      return;
    }
    if (pathname === '/preusmeri') {
      res.writeHead(301, { Location: '/o-nama' }).end();
      return;
    }
    if (pathname === '/petlja') {
      res.writeHead(302, { Location: '/petlja' }).end();
      return;
    }
    if (pathname === '/limit') {
      res.writeHead(429).end();
      return;
    }
    const route = ROUTES[pathname];
    if (!route) {
      res.writeHead(404, { 'Content-Type': 'text/html' }).end('<p>Nema</p>');
      return;
    }
    res.writeHead(200, { 'Content-Type': route.type ?? 'text/html; charset=utf-8' }).end(route.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

const options = { allowPrivate: true, delayMs: 0 };

test('crawl follows links, including those in the navigation it removes from the text', async () => {
  const pages = await crawl(`${base}/`, options);
  const paths = pages.map((page) => new URL(page.url).pathname);
  assert.equal(paths[0], '/');
  assert.ok(paths.includes('/o-nama'));
  assert.ok(paths.includes('/docs/a'));
  assert.ok(paths.includes('/docs/b'), 'follows relative links on inner pages');
});

test('crawl stays on the site and skips files, blocked and duplicate pages', async () => {
  requests.length = 0;
  const pages = await crawl(`${base}/`, options);
  const paths = pages.map((page) => new URL(page.url).pathname);

  assert.ok(!paths.includes('/zabranjeno'), 'robots.txt page must not be saved');
  assert.ok(!requests.includes('/zabranjeno'), 'robots.txt page must not even be requested');
  assert.ok(!requests.includes('/fajl.pdf'));
  assert.ok(!paths.includes('/slika'));
  assert.ok(!requests.includes('/tudje'), 'redirects to another host are not followed');
  assert.ok(!paths.includes('/ne-postoji'));
  assert.ok(!paths.includes('/kopija'), 'same text under another address is saved once');
  assert.equal(requests.filter((path) => path === '/o-nama').length, 1, 'fragments and queries are one page');
});

test('crawl keeps the text clean and fills in page details', async () => {
  const [home] = await crawl(`${base}/`, { ...options, maxPages: 1 });
  assert.equal(home.title, 'Pocetna');
  assert.equal(home.description, 'Opis sajta');
  assert.ok(home.text.includes('Glavna'));
  for (const noise of ['SCRIPT_TEXT', 'Footer tekst', 'Meni', 'O nama']) {
    assert.ok(!home.text.includes(noise), `text should not include "${noise}"`);
  }
  assert.ok(home.text.includes('Prvi Drugi'), 'neighboring blocks stay separate words');
});

test('crawl stops at maxPages and reports progress', async () => {
  const seen = [];
  const pages = await crawl(`${base}/`, { ...options, maxPages: 2, onPage: (count) => seen.push(count) });
  assert.equal(pages.length, 2);
  assert.deepEqual(seen, [1, 2]);
});

test('crawl reads pages under the start folder before the rest of the site', async () => {
  const pages = await crawl(`${base}/docs/a`, { ...options, maxPages: 2 });
  assert.deepEqual(pages.map((page) => new URL(page.url).pathname), ['/docs/a', '/docs/b']);
});

test('crawl follows menu links before links in the page body', async () => {
  const pages = await crawl(`${base}/vesti-start`, { ...options, maxPages: 3 });
  assert.deepEqual(pages.map((page) => new URL(page.url).pathname), ['/vesti-start', '/sekcija', '/rokovi']);
});

test('crawl follows a redirect on the start page', async () => {
  const [page] = await crawl(`${base}/preusmeri`, { ...options, maxPages: 1 });
  assert.equal(new URL(page.url).pathname, '/o-nama');
});

test('crawl decodes pages that are not UTF-8', async () => {
  const [page] = await crawl(`${base}/cp1250`, { ...options, maxPages: 1 });
  assert.ok(page.text.includes('šžčćđ'), page.text.slice(0, 30));
});

test('crawl stops early when the site asks it to slow down', async () => {
  requests.length = 0;
  const pages = await crawl(`${base}/rate-limit-start`, options);
  assert.deepEqual(pages.map((page) => new URL(page.url).pathname), ['/rate-limit-start']);
  assert.ok(requests.includes('/limit'));
  assert.ok(!requests.includes('/posle-limita'));
});

test('crawl still follows links from a page with too little text', async () => {
  const pages = await crawl(`${base}/samo-js-sa-linkom`, { ...options, maxPages: 2 });
  assert.equal(new URL(pages[0].url).pathname, '/o-nama');
});

test('crawl explains why a start page failed', async () => {
  const cases = [
    ['/samo-js', /premalo teksta/],
    ['/zabranjeno', /robots\.txt/],
    ['/slika', /nije HTML/],
    ['/ne-postoji', /HTTP 404/],
    ['/petlja', /preusmeravanja/],
  ];
  for (const [path, message] of cases) {
    await assert.rejects(crawl(`${base}${path}`, options), (error) => {
      assert.ok(error instanceof UserError, path);
      assert.match(error.message, message);
      return true;
    });
  }
});

test('crawl refuses local addresses unless they are allowed', async () => {
  requests.length = 0;
  await assert.rejects(crawl(`${base}/`, { delayMs: 0 }), /lokalne mreže/);
  assert.equal(requests.length, 0);
  for (const url of ['http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'http://localhost/']) {
    await assert.rejects(crawl(url, { delayMs: 0 }), /lokalne mreže/, url);
  }
});

test('assertPublicHost separates private from public addresses', async () => {
  for (const host of ['10.0.0.1', '172.16.5.5', '192.168.1.1', '127.0.0.1', '100.64.0.1', '[::1]', '[fe80::1]', '[fc00::1]', '[::ffff:10.0.0.1]', '[::ffff:127.0.0.1]']) {
    await assert.rejects(assertPublicHost(host), UserError, host);
  }
  for (const host of ['93.184.216.34', '1.1.1.1', '[2606:4700:4700::1111]']) {
    await assertPublicHost(host);
  }
});

test('parseStartUrl adds https and rejects anything that is not a web address', () => {
  assert.equal(parseStartUrl('etf.bg.ac.rs').href, 'https://etf.bg.ac.rs/');
  assert.equal(parseStartUrl(' http://a.com/x#y ').href, 'http://a.com/x');
  assert.equal(parseStartUrl('https://user:pass@a.com/').href, 'https://a.com/');
  for (const bad of ['', '   ', null, undefined, 'ftp://a.com', 'file:///etc/passwd', 'javascript:alert(1)', 'http://']) {
    assert.throws(() => parseStartUrl(bad), UserError, String(bad));
  }
});
