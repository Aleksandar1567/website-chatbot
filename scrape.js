import axios from 'axios';
import * as cheerio from 'cheerio';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Konfiguracija ------------------------------------------------
const START_URL = process.env.START_URL || 'https://www.etf.bg.ac.rs/';
const MAX_PAGES = Number(process.env.MAX_PAGES || 100);
const DELAY_MS = Number(process.env.DELAY_MS || 300); // pristojna pauza između zahteva
const OUT_FILE = path.join(__dirname, 'data', 'etf_pages.json');

const startHost = new URL(START_URL).hostname;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Normalizuj URL: ostavi samo http(s) linkove istog domena, bez hashova i query-ja. */
function normalize(href, base) {
  try {
    const url = new URL(href, base);
    if (url.hostname !== startHost) return null;
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    // preskoči ne-tekstualne fajlove
    if (/\.(pdf|jpg|jpeg|png|gif|svg|zip|doc|docx|ppt|pptx|xls|xlsx|mp3|mp4|webm)$/i.test(url.pathname)) {
      return null;
    }
    url.hash = '';
    url.search = '';
    return url.toString();
  } catch {
    return null;
  }
}

function extractText($) {
  $('script, style, noscript, iframe, nav, footer, header').remove();
  return $('body').text().replace(/\s+/g, ' ').trim();
}

async function fetchPage(url) {
  const response = await axios.get(url, {
    timeout: 15000,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (learning-project-chatbot; +educational use)',
    },
    responseType: 'text',
    maxRedirects: 5,
  });
  return response.data;
}

/** Izračunaj prioritet stranice. Veći broj = skrejpuje se ranije.
 *  Cilj: da studijski programi i predmeti (ono što korisnike zanima)
 *  budu obrađeni PRE nego što BFS red preplave stotine profila zaposlenih
 *  i vesti, koji imaju manju informativnu vrednost za chatbot. */
function priorityFor(url) {
  const u = url.toLowerCase();

  // Pojedinačni profil zaposlenog: /fakultet/zaposleni/ime-prezime-1234
  if (/\/zaposleni\/[a-z\u0100-\u017f]/.test(u)) return 1;

  // Vesti, najave, konkursi, obaveštenja — prolaznog karaktera
  if (/\/(vesti|najave|konkursi|obavestenja)\//.test(u)) return 2;

  // Ključne studijske stranice: programi, moduli, predmeti, upis, katedre
  if (/studiranje|upis|katedre|nastavni|predmeti|modul|master|osnovne|doktorske|akreditacij/.test(u)) return 100;

  // Ostalo (glavne sekcije, fakultet, nauka, sluzbe...)
  return 50;
}

/** Prioritetni red: čuva stavke [url, prioritet], sortirano opadajuće. */
function pushSorted(queue, item) {
  const idx = queue.findIndex((q) => q[1] < item[1]);
  if (idx === -1) queue.push(item);
  else queue.splice(idx, 0, item);
}

async function main() {
  const queue = [[START_URL, 999]];
  const queued = new Set([START_URL]);
  const visited = new Set();
  const pages = [];
  let errors = 0;

  console.log(`🌐 Pokrećem scraping: ${START_URL} (max ${MAX_PAGES} stranica)`);

  while (queue.length > 0 && pages.length < MAX_PAGES) {
    const [url] = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    try {
      const html = await fetchPage(url);
      const $ = cheerio.load(html);

      const title = ($('title').text() || url).trim();
      const text = extractText($);

      if (text.length > 0) {
        pages.push({ url, title, text });
        console.log(`  ✅ [${pages.length}] ${title.slice(0, 60)}`);
      }

      // prikupi linkove za dalje, svaki sa svojim prioritetom
      $('a[href]').each((_, el) => {
        const next = normalize($(el).attr('href'), url);
        if (next && !visited.has(next) && !queued.has(next)) {
          queued.add(next);
          pushSorted(queue, [next, priorityFor(next)]);
        }
      });
    } catch (err) {
      errors++;
      console.warn(`  ⚠️  Preskačem ${url}: ${err.message}`);
    }

    await sleep(DELAY_MS);
  }

  await mkdir(path.dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(pages, null, 2), 'utf8');

  console.log(`\n📦 Sačuvano ${pages.length} stranica u data/etf_pages.json`);
  console.log(`   Ukupno znakova teksta: ${pages.reduce((n, p) => n + p.text.length, 0)}`);
  if (errors > 0) console.log(`   ⚠️  ${errors} stranica nije moglo biti učitano`);
}

main().catch((err) => {
  console.error('❌ Greška:', err.message);
  process.exit(1);
});
