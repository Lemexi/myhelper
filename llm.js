// /src/llm.js
import { Groq } from 'groq-sdk';
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const MODEL_PRIMARY  = process.env.GROQ_MODEL_PRIMARY  || 'llama-3.3-70b-versatile';
const MODEL_FALLBACK = process.env.GROQ_MODEL_FALLBACK || 'llama-3.1-8b-instant';
const MODEL_EXPERT   = process.env.GROQ_MODEL_EXPERT   || 'openai/gpt-oss-120b';

export async function runLLM(messages, opts = {}) {
  const models = [MODEL_PRIMARY, MODEL_FALLBACK, MODEL_EXPERT];
  const { temperature = 0.7, top_p = 0.9, max_tokens = 400 } = opts;
  for (const model of models) {
    try {
      const resp = await groq.chat.completions.create({
        model, temperature, top_p, max_tokens, messages,
      });
      const text = resp?.choices?.[0]?.message?.content?.trim();
      if (text) return { model, text };
    } catch (e) {
      console.error('LLM error on', model, e.status || '', e.message);
    }
  }
  throw new Error('All LLM models failed');
}
