const el = (id) => document.getElementById(id);

const setupView = el('setup-view');
const setupForm = el('setup-form');
const setupSubmit = el('setup-submit');
const setupError = el('setup-error');
const setupProgress = el('setup-progress');
const progressText = el('progress-text');
const progressBar = el('progress-bar');
const urlInput = el('site-url');
const keyInput = el('api-key');
const keyHint = el('key-hint');
const providerSelect = el('provider');
const modelInput = el('model');
const maxPagesInput = el('max-pages');

const chatView = el('chat-view');
const chatEl = el('chat');
const chatForm = el('chat-form');
const messageInput = el('message-input');
const sendButton = el('send-button');

const POLL_MS = 600;
const MAX_HISTORY = 12;

// The API key stays in this page's memory only and is sent to the local server.
let credentials = {};
let currentSite = null;
let history = [];
let loadRun = 0;
let sending = false;
let providers = [];

async function api(path, body) {
  let response;
  try {
    response = await fetch(path, body && {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('Ne mogu da se povežem sa serverom. Da li je pokrenut?');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(data.error || 'Došlo je do greške.'), { status: response.status });
  }
  return data;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* Setup screen */

function showSetupError(message) {
  setupError.textContent = message;
  setupError.hidden = !message;
}

function showProgress(site) {
  const pages = `Pročitano stranica: ${site.pages}.`;
  const messages = {
    crawl: site.pages ? `Čitam sajt… ${pages}` : 'Čitam sajt…',
    profile: `${pages} Model analizira o čemu je sajt…`,
    model: 'Učitavam model za pretragu. Prvi put se skida oko 130 MB…',
    embed: `Pravim indeks za pretragu… ${site.embedded} od ${site.chunks || '?'}`,
  };
  progressText.textContent = messages[site.stage] ?? 'Radim…';

  if (site.stage === 'embed' && site.chunks > 0) {
    progressBar.max = site.chunks;
    progressBar.value = site.embedded;
  } else {
    progressBar.removeAttribute('value');
  }
}

function setLoading(loading) {
  setupSubmit.disabled = loading;
  setupSubmit.textContent = loading ? 'Radim…' : 'Napravi bota';
  setupProgress.hidden = !loading;
}

async function loadSite(event) {
  event.preventDefault();
  showSetupError('');
  credentials = {
    apiKey: keyInput.value.trim(),
    provider: providerSelect.value,
    model: modelInput.value.trim(),
  };

  const run = ++loadRun;
  setLoading(true);
  progressText.textContent = 'Čitam sajt…';
  progressBar.removeAttribute('value');
  try {
    let site = await api('/api/sites', { url: urlInput.value, maxPages: maxPagesInput.value, ...credentials });
    while (site.status === 'loading') {
      showProgress(site);
      await wait(POLL_MS);
      if (run !== loadRun) return;
      site = await api(`/api/sites/${site.id}`);
    }
    if (site.status === 'error') throw new Error(site.error);
    openChat(site);
  } catch (error) {
    if (run === loadRun) showSetupError(error.message);
  } finally {
    if (run === loadRun) setLoading(false);
  }
}

async function loadConfig() {
  let config;
  try {
    config = await api('/api/config');
  } catch (error) {
    showSetupError(error.message);
    return;
  }
  ({ providers } = config);
  maxPagesInput.placeholder = config.defaultMaxPages;
  maxPagesInput.max = config.maxPagesLimit;

  for (const provider of providers) {
    const option = document.createElement('option');
    option.value = provider.id;
    option.textContent = provider.label;
    providerSelect.append(option);
  }
  const fromEnv = providers.find((provider) => provider.hasEnvKey);
  if (fromEnv) {
    keyHint.textContent = `Možeš da ostaviš prazno. Tada se koristi ${fromEnv.label} ključ iz .env fajla.`;
  }
}

providerSelect.addEventListener('change', () => {
  const provider = providers.find(({ id }) => id === providerSelect.value);
  modelInput.placeholder = provider ? provider.model : 'Podrazumevani model';
});

setupForm.addEventListener('submit', loadSite);

/* Chat screen */

function scrollToEnd() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

function addMessage(text, kind) {
  const wrapper = document.createElement('div');
  wrapper.className = `message ${kind}`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  wrapper.append(bubble);
  chatEl.append(wrapper);
  scrollToEnd();
  return wrapper;
}

function showTyping() {
  const wrapper = addMessage('', 'bot');
  wrapper.firstChild.classList.add('typing');
  return wrapper;
}

function addSources(sources) {
  if (!sources?.length) return;
  const wrapper = addMessage('', 'bot sources');
  const box = wrapper.firstChild;
  const heading = document.createElement('strong');
  heading.textContent = 'Izvori';
  box.append(heading);

  for (const source of sources) {
    const row = document.createElement('div');
    row.textContent = `[${source.refs.join(', ')}] `;
    const link = document.createElement('a');
    link.href = source.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = source.title;
    row.append(link);
    box.append(row);
  }
  scrollToEnd();
}

function addSuggestions(questions) {
  if (!questions?.length) return;
  const list = document.createElement('div');
  list.className = 'suggestions';
  list.id = 'suggestions';
  for (const question of questions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'suggestion';
    button.textContent = question;
    button.addEventListener('click', () => sendMessage(question));
    list.append(button);
  }
  chatEl.append(list);
  scrollToEnd();
}

function openChat(site) {
  currentSite = site;
  history = [];
  chatEl.replaceChildren();

  const { profile, llm } = site;
  document.title = `${profile.name} · Chatbot`;
  el('site-name').textContent = profile.name;
  el('site-avatar').textContent = profile.name.charAt(0).toUpperCase();
  el('site-status').textContent = `${llm.label} · ${llm.model} · pročitano stranica: ${site.pages}`;

  if (profile.summary) {
    const summary = document.createElement('p');
    summary.className = 'site-summary';
    summary.textContent = profile.summary;
    chatEl.append(summary);
  }
  if (site.totalChunks > site.chunks) {
    const note = document.createElement('p');
    note.className = 'site-summary';
    note.textContent = `Sajt je veliki, pa je indeksiran samo deo teksta (${site.chunks} od ${site.totalChunks} delova).`;
    chatEl.append(note);
  }
  if (profile.notice) addMessage(profile.notice, 'bot error');
  addMessage(profile.welcome, 'bot');
  addSuggestions(profile.suggestions);

  setupView.hidden = true;
  chatView.hidden = false;
  messageInput.focus();
}

function backToSetup(errorMessage = '') {
  loadRun++;
  currentSite = null;
  history = [];
  document.title = 'Website Chatbot';
  setLoading(false);
  showSetupError(errorMessage);
  chatView.hidden = true;
  setupView.hidden = false;
  urlInput.focus();
}

async function sendMessage(text) {
  const message = text.trim();
  if (!message || sending || !currentSite) return;

  sending = true;
  sendButton.disabled = true;
  el('suggestions')?.remove();
  addMessage(message, 'user');
  messageInput.value = '';
  const typing = showTyping();

  try {
    const data = await api('/api/chat', { siteId: currentSite.id, message, history, ...credentials });
    typing.remove();
    addMessage(data.reply, 'bot');
    addSources(data.sources);
    history = [
      ...history,
      { role: 'user', content: message },
      { role: 'assistant', content: data.reply },
    ].slice(-MAX_HISTORY);
  } catch (error) {
    typing.remove();
    if (error.status === 404) {
      backToSetup(error.message);
      return;
    }
    addMessage(error.message, 'bot error');
  } finally {
    sending = false;
    sendButton.disabled = false;
    if (currentSite) messageInput.focus();
  }
}

chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  sendMessage(messageInput.value);
});

el('change-site').addEventListener('click', () => backToSetup());

loadConfig();
