// Runs the real SDKs against a local fake server, so request shapes and response
// parsing are checked without an API key or any cost.

import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { UserError } from '../lib/errors.js';
import { createLlm, describeFailure, detectProvider, PROVIDERS } from '../lib/providers.js';

const KEY = 'test-secret-key-123456';
const REQUEST = {
  system: 'Sistemska poruka',
  messages: [
    { role: 'user', content: 'Prvo pitanje' },
    { role: 'assistant', content: 'Prvi odgovor' },
    { role: 'user', content: 'Drugo pitanje' },
  ],
};

let server;
let baseUrl;
let captured;
let reply;
let requestCount;
let firstReplies;

before(async () => {
  server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    captured = { path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') };
    requestCount++;
    const current = firstReplies.shift() ?? reply;
    res.writeHead(current.status ?? 200, { 'Content-Type': 'application/json' }).end(JSON.stringify(current.body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

beforeEach(() => {
  captured = null;
  requestCount = 0;
  firstReplies = [];
});

const claudeMessage = (overrides) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'Od Claude-a' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
  ...overrides,
});

test('detectProvider recognizes key formats', () => {
  assert.equal(detectProvider('sk-ant-api03-abc'), 'anthropic');
  assert.equal(detectProvider('AIzaSyAbc'), 'gemini');
  assert.equal(detectProvider('sk-proj-abc'), 'openai');
  assert.equal(detectProvider('sk-abc'), 'openai');
  assert.equal(detectProvider('nesto-drugo'), null);
});

test('Claude: sends the expected request and reads only text blocks', async () => {
  reply = { body: claudeMessage() };
  const llm = createLlm({ provider: 'anthropic', apiKey: KEY, baseUrl });
  assert.equal(llm.model, PROVIDERS.anthropic.model);
  assert.equal(await llm.complete(REQUEST), 'Od Claude-a');

  assert.match(captured.path, /^\/v1\/messages/);
  assert.equal(captured.headers.authorization, `Bearer ${KEY}`);
  assert.match(captured.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.equal(captured.body.model, 'claude-opus-5-5');
  assert.equal(captured.body.fallbacks, 'default');
  assert.equal(captured.body.output_config.effort, 'low');
  assert.equal(captured.body.system, REQUEST.system);
  assert.deepEqual(captured.body.messages, REQUEST.messages);
  assert.ok(!('temperature' in captured.body));
  assert.ok(!('thinking' in captured.body));
});

test('Claude: a refusal becomes a clear error', async () => {
  reply = { body: claudeMessage({ content: [], stop_reason: 'refusal' }) };
  const llm = createLlm({ provider: 'anthropic', apiKey: KEY, baseUrl });
  await assert.rejects(llm.complete(REQUEST), (error) => {
    assert.ok(error instanceof UserError);
    assert.match(error.message, /odbio/);
    return true;
  });
});

test('Claude: a rejected key becomes a clear error without the key', async () => {
  reply = { status: 401, body: { type: 'error', error: { type: 'authentication_error', message: `bad ${KEY}` } } };
  const llm = createLlm({ provider: 'anthropic', apiKey: KEY, baseUrl });
  await assert.rejects(llm.complete(REQUEST), (error) => {
    assert.equal(error.status, 401);
    assert.match(error.message, /API ključ/);
    assert.ok(!error.message.includes(KEY));
    return true;
  });
});

test('OpenAI: sends the expected request and reads the text', async () => {
  process.env.OPENAI_ORG_ID = 'org-from-shell';
  process.env.OPENAI_PROJECT_ID = 'project-from-shell';
  reply = {
    body: {
      id: 'resp_1',
      object: 'response',
      created_at: 0,
      status: 'completed',
      model: 'gpt-5.5',
      output: [{
        type: 'message',
        id: 'm1',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Od OpenAI-ja', annotations: [] }],
      }],
      parallel_tool_calls: true,
      tool_choice: 'auto',
      tools: [],
    },
  };
  const llm = createLlm({ provider: 'openai', apiKey: KEY, model: 'gpt-custom', baseUrl: `${baseUrl}/v1` });
  try {
    assert.equal(await llm.complete(REQUEST), 'Od OpenAI-ja');
  } finally {
    delete process.env.OPENAI_ORG_ID;
    delete process.env.OPENAI_PROJECT_ID;
  }

  assert.equal(captured.path, '/v1/responses');
  assert.equal(captured.headers.authorization, `Bearer ${KEY}`);
  assert.equal(captured.headers['openai-organization'], undefined);
  assert.equal(captured.headers['openai-project'], undefined);
  assert.equal(captured.body.model, 'gpt-custom');
  assert.equal(captured.body.instructions, REQUEST.system);
  assert.deepEqual(captured.body.input, REQUEST.messages);
});

test('OpenAI: an unknown model becomes a clear error', async () => {
  reply = { status: 404, body: { error: { message: 'no such model', type: 'invalid_request_error' } } };
  const llm = createLlm({ provider: 'openai', apiKey: KEY, model: 'nema-ga', baseUrl: `${baseUrl}/v1` });
  await assert.rejects(llm.complete(REQUEST), /nema model "nema-ga"/);
});

test('Gemini: sends the expected request and reads the text', async () => {
  reply = {
    body: { candidates: [{ content: { role: 'model', parts: [{ text: 'Od Geminija' }] }, finishReason: 'STOP' }] },
  };
  const llm = createLlm({ provider: 'gemini', apiKey: KEY, baseUrl });
  assert.equal(await llm.complete(REQUEST), 'Od Geminija');

  assert.match(captured.path, new RegExp(`models/${PROVIDERS.gemini.model}:generateContent`));
  assert.equal(captured.headers['x-goog-api-key'], KEY);
  assert.deepEqual(captured.body.contents, [
    { role: 'user', parts: [{ text: 'Prvo pitanje' }] },
    { role: 'model', parts: [{ text: 'Prvi odgovor' }] },
    { role: 'user', parts: [{ text: 'Drugo pitanje' }] },
  ]);
  assert.match(JSON.stringify(captured.body.systemInstruction), /Sistemska poruka/);
});

test('Gemini: its "bad key" status 400 becomes a clear error', async () => {
  reply = {
    status: 400,
    body: { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } },
  };
  const llm = createLlm({ provider: 'gemini', apiKey: KEY, baseUrl });
  await assert.rejects(llm.complete(REQUEST), (error) => {
    assert.equal(error.status, 401);
    assert.match(error.message, /API ključ/);
    return true;
  });
});

test('Gemini: a brief overload is retried and then succeeds', async () => {
  firstReplies = [{ status: 503, body: { error: { code: 503, message: 'overloaded', status: 'UNAVAILABLE' } } }];
  reply = {
    body: { candidates: [{ content: { role: 'model', parts: [{ text: 'Posle ponavljanja' }] }, finishReason: 'STOP' }] },
  };
  const llm = createLlm({ provider: 'gemini', apiKey: KEY, baseUrl });
  assert.equal(await llm.complete(REQUEST), 'Posle ponavljanja');
  assert.equal(requestCount, 2);
});

test('Gemini: a rejected key is not retried', async () => {
  reply = { status: 400, body: { error: { code: 400, message: 'API key not valid.', status: 'INVALID_ARGUMENT' } } };
  const llm = createLlm({ provider: 'gemini', apiKey: KEY, baseUrl });
  await assert.rejects(llm.complete(REQUEST), /API ključ/);
  assert.equal(requestCount, 1);
});

test('Gemini: a used-up quota is not retried and suggests another model', async () => {
  reply = { status: 429, body: { error: { code: 429, message: 'quota', status: 'RESOURCE_EXHAUSTED' } } };
  const llm = createLlm({ provider: 'gemini', apiKey: KEY, baseUrl });
  await assert.rejects(llm.complete(REQUEST), (error) => {
    assert.equal(error.status, 429);
    assert.match(error.message, /dnevni limit.*drugi model/);
    return true;
  });
  assert.equal(requestCount, 1);
});

test('Gemini: a blocked answer with no text becomes a clear error', async () => {
  reply = { body: { candidates: [], promptFeedback: { blockReason: 'SAFETY' } } };
  const llm = createLlm({ provider: 'gemini', apiKey: KEY, baseUrl });
  await assert.rejects(llm.complete(REQUEST), /nije vratio odgovor/);
});

test('describeFailure gives useful messages and never repeats provider text', () => {
  const secretText = `failed for ${KEY}`;
  const cases = [
    [{ status: 429, message: secretText }, 429, /limit/],
    [{ status: 503, message: secretText }, 503, /preopterećen/],
    [{ status: 504, message: secretText }, 503, /preopterećen/],
    [{ status: 529, message: secretText }, 503, /preopterećen/],
    [{ status: 400, message: 'Your credit balance is too low' }, 402, /kredita/],
    [{ status: 500, message: secretText }, 502, /status 500/],
    [{ message: secretText }, 502, /Ne mogu da dođem/],
    [undefined, 502, /Ne mogu da dođem/],
  ];
  for (const [error, status, pattern] of cases) {
    const failure = describeFailure(error, 'Claude', 'model-x');
    assert.equal(failure.status, status);
    assert.match(failure.message, pattern);
    assert.ok(!failure.message.includes(KEY));
  }
});
