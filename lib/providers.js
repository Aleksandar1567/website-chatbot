// One complete({ system, messages }) call for each supported model provider.

import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import { UserError } from './errors.js';

const TIMEOUT_MS = 60_000;

export const PROVIDERS = {
  gemini: { label: 'Gemini', envKey: 'GEMINI_API_KEY', model: 'gemini-3.5-flash-lite' },
  anthropic: { label: 'Claude', envKey: 'ANTHROPIC_API_KEY', model: 'claude-opus-5-5' },
  openai: { label: 'OpenAI', envKey: 'OPENAI_API_KEY', model: 'gpt-5.5' },
};

export function detectProvider(apiKey) {
  if (apiKey.startsWith('sk-ant-')) return 'anthropic';
  if (apiKey.startsWith('AIza')) return 'gemini';
  if (apiKey.startsWith('sk-')) return 'openai';
  return null;
}

/** Maps a provider failure to a message for the UI. It never includes the raw error, which could echo a key. */
export function describeFailure(error, label, model) {
  const status = error?.status;
  const details = String(error?.message ?? '');
  console.error(`${label} request failed with status ${status ?? 'none'}`);

  if (status === 401 || status === 403 || (status === 400 && /api.?key/i.test(details))) {
    return new UserError(`${label} nije prihvatio API ključ. Proveri ključ i probaj ponovo.`, 401);
  }
  if (status === 404) return new UserError(`${label} nema model "${model}" ili ti on nije dostupan.`, 400);
  if (status === 429) {
    return new UserError(
      `${label} javlja da je dostignut limit. Besplatni ključevi imaju i dnevni limit, pa probaj kasnije ili izaberi drugi model u delu Napredno.`,
      429,
    );
  }
  if (status === 503 || status === 504 || status === 529) {
    return new UserError(`${label} je trenutno preopterećen. Probaj ponovo za minut.`, 503);
  }
  if (/credit|billing|quota/i.test(details)) {
    return new UserError(`${label} javlja da na nalogu nema dovoljno kredita.`, 402);
  }
  if (status === undefined) return new UserError(`Ne mogu da dođem do servisa ${label}.`, 502);
  return new UserError(`${label} je vratio grešku (status ${status}).`, 502);
}

const CALLERS = {
  async gemini({ apiKey, model, baseUrl, system, messages }) {
    // The other two SDKs retry brief failures by default, and this one only when
    // asked. A used-up quota (429) is left out, because free keys have a daily limit.
    const client = new GoogleGenAI({
      apiKey,
      vertexai: false,
      httpOptions: {
        timeout: TIMEOUT_MS,
        retryOptions: { attempts: 3, httpStatusCodes: [500, 502, 503, 504] },
        ...(baseUrl && { baseUrl }),
      },
    });
    const response = await client.models.generateContent({
      model,
      contents: messages.map(({ role, content }) => ({
        role: role === 'assistant' ? 'model' : 'user',
        parts: [{ text: content }],
      })),
      config: { systemInstruction: system },
    });
    return response.text;
  },

  async anthropic({ apiKey, model, baseUrl, system, messages }) {
    const client = new Anthropic({ apiKey, timeout: TIMEOUT_MS, ...(baseUrl && { baseURL: baseUrl }) });
    const response = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      output_config: { effort: 'low' },
      // If a safety classifier declines, the API retries on a fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system,
      messages,
    });
    if (response.stop_reason === 'refusal') {
      throw new UserError('Claude je odbio da odgovori na ovo pitanje.', 422);
    }
    return response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
  },

  async openai({ apiKey, model, baseUrl, system, messages }) {
    // Empty organization and project keep shell variables out of the request.
    const client = new OpenAI({
      apiKey,
      organization: null,
      project: null,
      timeout: TIMEOUT_MS,
      ...(baseUrl && { baseURL: baseUrl }),
    });
    const response = await client.responses.create({ model, instructions: system, input: messages });
    return response.output_text;
  },
};

export function createLlm({ provider, apiKey, model, baseUrl }) {
  const { label, model: defaultModel } = PROVIDERS[provider];
  const modelName = model || defaultModel;

  return {
    provider,
    label,
    model: modelName,
    async complete({ system, messages }) {
      let text;
      try {
        text = await CALLERS[provider]({ apiKey, model: modelName, baseUrl, system, messages });
      } catch (error) {
        throw error instanceof UserError ? error : describeFailure(error, label, modelName);
      }
      if (!text?.trim()) throw new UserError(`${label} nije vratio odgovor. Probaj ponovo.`, 502);
      return text.trim();
    },
  };
}
