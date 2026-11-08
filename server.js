import 'dotenv/config';
import express from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

// --- 1. Middleware ------------------------------------------------
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- 2. Gemini setup ----------------------------------------------
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.warn('⚠️  GEMINI_API_KEY is not set. Copy .env.example to .env and add your key.');
}

const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;
const MODEL_NAME = 'gemini-3.6-flash';

// Model koji odgovara isključivo iz lokalnog (scrapovanog) znanja.
const model = genAI?.getGenerativeModel({ model: MODEL_NAME });

// Fallback model sa Google Search grounding (web pretragom). Koristi se
// kada lokalno znanje nema odgovor — tada model sam pretraži web i izvuče izvore.
const searchModel = genAI?.getGenerativeModel({
  model: MODEL_NAME,
  tools: [{ googleSearch: {} }],
});

// --- 3. Scraped knowledge base ------------------------------------
const DATA_FILE = path.join(__dirname, 'data', 'etf_pages.json');

async function loadKnowledgeBase() {
  if (!existsSync(DATA_FILE)) {
    return [];
  }
  try {
    const raw = await readFile(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.warn('⚠️  Could not read knowledge base:', err.message);
    return [];
  }
}

/**
 * A very simple "retrieval" step: score every scraped page by how many
 * words from the user's question appear in it, and return the best matches.
 * (A real project would use embeddings + vector search — this keeps it simple.)
 */
function scorePages(pages, question) {
  const words = question
    .toLowerCase()
    .split(/[^a-zšđčćž0-9]+/i)
    .filter((w) => w.length > 2);

  return pages
    .map((page) => {
      const text = `${page.title} ${page.text}`.toLowerCase();
      let score = 0;
      for (const word of words) {
        if (text.includes(word)) score++;
      }
      return { ...page, score };
    })
    .filter((page) => page.score > 0)
    .sort((a, b) => b.score - a.score);
}

function buildContext(pages, question) {
  const top = scorePages(pages, question).slice(0, 5);
  if (top.length === 0) return null;

  return top
    .map((p) => `## ${p.title}\nURL: ${p.url}\n${p.text.slice(0, 1500)}`)
    .join('\n\n---\n\n');
}

// --- 4. Chat helpers ----------------------------------------------

function localSystemPrompt(context) {
  return `Ti si korisni asistent za ETF (Elektrotehnički fakultet) u Beogradu.
Odgovaraj na srpskom jeziku, kratko i jasno.
Koristi isključivo informacije iz priloženog konteksta.
Ako odgovor nije u kontekstu, reci da ne znaš — nemoj izmišljati.

KONTEKST (sa sajta etf.bg.ac.rs):
${context}`;
}

/** Odgovor iz lokalnog (scrapovanog) znanja — bez web pretrage. */
async function answerFromLocal(message, context) {
  const result = await model.generateContent({
    contents: [
      { role: 'user', parts: [{ text: localSystemPrompt(context) }] },
      { role: 'model', parts: [{ text: 'Razumem. Pitaćeš me pitanja, a ja ću odgovoriti.' }] },
      { role: 'user', parts: [{ text: message }] },
    ],
  });
  return { reply: result.response.text(), sources: [] };
}

/** Fallback: pretraži web pomoću Google Search grounding-a. */
async function answerFromWeb(message) {
  const result = await searchModel.generateContent({
    contents: [{ role: 'user', parts: [{ text: message }] }],
  });

  const reply = result.response.text();
  const chunks = result.response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const sources = [...new Set(chunks.map((c) => c.web?.uri).filter(Boolean))];
  return { reply, sources };
}

// --- 5. Chat endpoint ---------------------------------------------
app.post('/api/chat', async (req, res) => {
  const message = (req.body?.message || '').trim();
  if (!message) {
    return res.status(400).json({ error: 'Message is required.' });
  }
  if (!model || !searchModel) {
    return res.status(500).json({ error: 'Gemini API key is not configured.' });
  }

  try {
    const pages = await loadKnowledgeBase();
    const context = buildContext(pages, message);

    let result;
    if (context) {
      // 1. Pokušaj da odgovoriš iz lokalnog scrapovanog znanja.
      result = await answerFromLocal(message, context);
    } else {
      // 2. Nema lokalnog konteksta → pretraži web.
      console.log('  🔎 Nema lokalnog konteksta — pretražujem web...');
      result = await answerFromWeb(message);
    }

    res.json(result);
  } catch (err) {
    console.error('Gemini error:', err.message);
    res.status(500).json({ error: 'Something went wrong calling the AI model.' });
  }
});

// --- 6. Start server ----------------------------------------------
app.listen(PORT, () => {
  console.log(`🚀 Chatbot server running at http://localhost:${PORT}`);
});
