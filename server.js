import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createApp } from './lib/app.js';

const root = path.dirname(fileURLToPath(import.meta.url));

// API keys come only from the web form or this project's .env file. Keys that
// happen to be set in the shell are ignored, so the bot never spends on an
// account that nobody chose for it.
const env = {};
dotenv.config({ path: path.join(root, '.env'), processEnv: env, quiet: true });
const setting = (name) => process.env[name] ?? env[name];

const crawlOptions = {
  allowPrivate: setting('ALLOW_PRIVATE_URLS') === '1',
  ...(Number(setting('MAX_PAGES')) > 0 && { maxPages: Number(setting('MAX_PAGES')) }),
};

const port = Number(setting('PORT')) || 3000;
const app = createApp({ env, crawlOptions });

app.listen(port, '127.0.0.1', (error) => {
  if (error) {
    console.error(`Could not start on port ${port}: ${error.message}`);
    process.exit(1);
  }
  console.log(`Chatbot running at http://localhost:${port}`);
});
