// server.js — RenovoGo LLM backend (чистый, без дублей, с chat_id)
// Запуск: node server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { z } from 'zod';
import { Groq } from 'groq-sdk';
import { SYSTEM_PROMPT } from './prompt.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));
app.use(cors({ origin: true }));

// ===== env =====
const PORT = process.env.PORT || 8080;
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const MODEL_PRIMARY  = process.env.GROQ_MODEL_PRIMARY  || 'llama-3.3-70b-versatile';
const MODEL_FALLBACK = process.env.GROQ_MODEL_FALLBACK || 'llama-3.1-8b-instant';
const MODEL_EXPERT   = process.env.GROQ_MODEL_EXPERT   || 'openai/gpt-oss-120b';

const REPLY_MAX_TOKENS = Number(process.env.REPLY_MAX_TOKENS || 400);
const TEMPERATURE = Number(process.env.TEMPERATURE || 0.7);
const TOP_P = Number(process.env.TOP_P || 0.9);

// ===== utils & schemas =====
const Msg = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().min(1)
});

const BodySchema = z.object({
  message: z.string().min(1),
  history: z.array(Msg).optional(),
  mode: z.enum(['auto', 'expert', 'fallback']).optional().default('auto'),
  language: z.string().optional(),     // принудительный язык ответа (опционально)
  chat_id: z.string().optional()       // телеграм-сессия (опционально)
});

function pickModel(mode) {
  if (mode === 'expert')   return MODEL_EXPERT;
  if (mode === 'fallback') return MODEL_FALLBACK;
  return MODEL_PRIMARY;
}

// Простейшее «усечение» истории по символам (дешёвая эвристика)
function truncateHistory(history = [], maxChars = 12000) {
  const arr = [...history];
  let total = arr.reduce((n, m) => n + m.content.length, 0);
  while (total > maxChars && arr.length > 0) {
    const firstUserIdx = arr.findIndex(m => m.role === 'user' || m.role === 'assistant');
    arr.splice(firstUserIdx >= 0 ? firstUserIdx : 0, 1);
    total = arr.reduce((n, m) => n + m.content.length, 0);
  }
  return arr;
}

// ===== health =====
app.get('/', (_, res) => res.type('text/plain').send('OK Renovogo backend'));
app.get('/health', (_, res) => res.json({ ok: true, model: MODEL_PRIMARY }));

// ===== main reply =====
app.post('/api/reply', async (req, res) => {
  let payload;
  try {
    payload = BodySchema.parse(req.body);
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'Bad request', details: e.errors });
  }

  const { message, history = [], mode, language /*, chat_id */ } = payload;
  const model = pickModel(mode);

  // Собираем сообщения для LLM
  const msgs = [
    { role: 'system', content: SYSTEM_PROMPT + (language ? `\nОтвечай на языке: ${language}` : '') },
    ...truncateHistory(history),
    { role: 'user', content: message }
  ];

  // Попытка 1: выбранная модель
  try {
    const resp = await groq.chat.completions.create({
      model,
      messages: msgs,
      temperature: TEMPERATURE,
      top_p: TOP_P,
      max_tokens: REPLY_MAX_TOKENS
    });

    const text = resp.choices?.[0]?.message?.content?.trim() || '';
    return res.json({ ok: true, model, reply: text });
  } catch (err) {
    // Fallback на 8B, если первичная модель недоступна
    try {
      const resp2 = await groq.chat.completions.create({
        model: MODEL_FALLBACK,
        messages: msgs,
        temperature: TEMPERATURE,
        top_p: TOP_P,
        max_tokens: REPLY_MAX_TOKENS
      });
      const text2 = resp2.choices?.[0]?.message?.content?.trim() || '';
      return res.json({
        ok: true,
        model: MODEL_FALLBACK,
        reply: text2,
        warning: `primary_failed:${String(err?.message || err)}`
      });
    } catch (err2) {
      return res.status(500).json({ ok: false, error: 'LLM failed', details: String(err2?.message || err2) });
    }
  }
});

// ===== start =====
app.listen(PORT, () => {
  console.log(`[manager-bot] http://localhost:${PORT}  model=${MODEL_PRIMARY}`);
});
