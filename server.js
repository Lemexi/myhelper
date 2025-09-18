// server.js — RenovoGo backend (health, actions, chat)
// v2025-09-18-1 — разделён на разделы, масштабируемая архитектура

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { z } from 'zod';
import { Groq } from 'groq-sdk';
import { SYSTEM_PROMPT } from './prompt.js';

/* ──────────────────────────────────────────────────────────────
   ЧАСТЬ 1. НАСТРОЙКИ, APP, МОДЕЛИ
   ────────────────────────────────────────────────────────────── */

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));
app.use(cors({ origin: true }));

const PORT = process.env.PORT || 8080;
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const MODEL_PRIMARY  = process.env.GROQ_MODEL_PRIMARY  || 'llama-3.3-70b-versatile';
const MODEL_FALLBACK = process.env.GROQ_MODEL_FALLBACK || 'llama-3.1-8b-instant';
const MODEL_EXPERT   = process.env.GROQ_MODEL_EXPERT   || 'openai/gpt-oss-120b';

const REPLY_MAX_TOKENS = Number(process.env.REPLY_MAX_TOKENS || 400);
const TEMPERATURE = Number(process.env.TEMPERATURE || 0.7);
const TOP_P = Number(process.env.TOP_P || 0.9);

/* ──────────────────────────────────────────────────────────────
   ЧАСТЬ 2. СХЕМЫ ZOD (включая старый и новый форматы)
   ────────────────────────────────────────────────────────────── */

const Msg = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().min(1)
});

const SessionSchema = z.object({
  trust_score: z.number().optional().default(0),
  memory: z.record(z.any()).optional(),
  persona: z.string().optional().default('Victor/Manager')
}).optional().default({ trust_score: 0, persona: 'Victor/Manager' });

const ExampleItem = z.object({
  tag: z.string().min(1),
  content: z.string().min(1)
});

const CommonEnvelope = z.object({
  chat_id: z.string().optional(),
  mode: z.enum(['auto','expert','fallback']).optional().default('auto')
});

const ActionTranslate = CommonEnvelope.extend({
  action: z.literal('translate'),
  style: z.string().optional().default('sales_neurocopy'),
  src_lang: z.string().optional().default('ru'),
  tgt_lang: z.string().optional().default('en'),
  text: z.string().min(1),
  need_ru_echo: z.boolean().optional().default(true),
  // опционально: для расширений
  messages: z.array(Msg).optional(),
  session: SessionSchema,
  examples: z.array(ExampleItem).optional().default([])
});

const ActionRewriteRu = CommonEnvelope.extend({
  action: z.literal('rewrite_ru'),
  text: z.string().min(1),
  note: z.string().optional().default(''),
  messages: z.array(Msg).optional(),
  session: SessionSchema,
  examples: z.array(ExampleItem).optional().default([])
});

const ActionRecomposeSales = CommonEnvelope.extend({
  action: z.literal('recompose_sales'),
  text: z.string().min(1),
  hints: z.record(z.any()).optional(),
  messages: z.array(Msg).optional(),
  session: SessionSchema,
  examples: z.array(ExampleItem).optional().default([])
});

// Новый универсальный формат без action
const ChatPayloadNew = CommonEnvelope.extend({
  messages: z.array(Msg),
  session: SessionSchema,
  examples: z.array(ExampleItem).optional().default([]),
  language: z.string().optional()
});

// Старый формат без action
const ChatPayloadLegacy = CommonEnvelope.extend({
  message: z.string().min(1),
  history: z.array(Msg).optional().default([]),
  language: z.string().optional()
});

const BodySchema = z.union([
  ActionTranslate,
  ActionRewriteRu,
  ActionRecomposeSales,
  ChatPayloadNew,
  ChatPayloadLegacy
]);

/* ──────────────────────────────────────────────────────────────
   ЧАСТЬ 3. УТИЛИТЫ: выбор модели, усечение истории, LLM-вызовы
   ────────────────────────────────────────────────────────────── */

function pickModel(mode) {
  if (mode === 'expert')   return MODEL_EXPERT;
  if (mode === 'fallback') return MODEL_FALLBACK;
  return MODEL_PRIMARY;
}

function truncateHistory(history = [], maxChars = 12000) {
  const arr = [...history];
  let total = arr.reduce((n, m) => n + (m.content?.length || 0), 0);
  while (total > maxChars && arr.length > 0) {
    const i = arr.findIndex(m => m.role === 'user' || m.role === 'assistant');
    arr.splice(i >= 0 ? i : 0, 1);
    total = arr.reduce((n, m) => n + (m.content?.length || 0), 0);
  }
  return arr;
}

async function runLLM({ model, messages, temperature = TEMPERATURE, top_p = TOP_P, max_tokens = REPLY_MAX_TOKENS }) {
  try {
    const resp = await groq.chat.completions.create({
      model,
      messages,
      temperature,
      top_p,
      max_tokens
    });
    const text = resp.choices?.[0]?.message?.content?.trim() || '';
    return { ok: true, model, text };
  } catch (err) {
    // fallback
    if (model !== MODEL_FALLBACK) {
      try {
        const resp2 = await groq.chat.completions.create({
          model: MODEL_FALLBACK,
          messages,
          temperature,
          top_p,
          max_tokens
        });
        const text2 = resp2.choices?.[0]?.message?.content?.trim() || '';
        return { ok: true, model: MODEL_FALLBACK, text: text2, warning: 'primary_failed:' + String(err?.message || err) };
      } catch (err2) {
        return { ok: false, error: 'LLM failed', details: String(err2?.message || err2) };
      }
    }
    return { ok: false, error: 'LLM failed', details: String(err?.message || err) };
  }
}

/* ──────────────────────────────────────────────────────────────
   ЧАСТЬ 4. СИСТЕМНЫЙ ПРОМПТ: сессия + примеры
   ────────────────────────────────────────────────────────────── */

function makeSystemPrompt({ language, session, examples }) {
  const lines = [SYSTEM_PROMPT];

  if (session?.persona) {
    lines.push(`\nПерсона: ${session.persona}`);
  }
  if (typeof session?.trust_score === 'number') {
    lines.push(`\nТекущий trust_score: ${session.trust_score}`);
  }
  if (session?.memory && Object.keys(session.memory).length > 0) {
    lines.push(`\nПостоянные предпочтения/память:\n${JSON.stringify(session.memory)}`);
  }
  if (Array.isArray(examples) && examples.length > 0) {
    const filtered = examples.filter(e => e.tag === 'would_answer').slice(0, 12);
    if (filtered.length) {
      lines.push(`\nПримеры стиля (would_answer) — ориентируйся на тон, структуру и логику (не копируй дословно):`);
      for (const ex of filtered) {
        lines.push(`— ${ex.content}`);
      }
    }
  }
  if (language) {
    lines.push(`\nОтвечай на языке: ${language}`);
  }
  return lines.join('\n');
}

/* ──────────────────────────────────────────────────────────────
   ЧАСТЬ 5. ОБРАБОТЧИКИ ACTIONS
   ────────────────────────────────────────────────────────────── */

// 5.1 Продающий перевод с ру-эхо
async function handleTranslate(body) {
  const {
    chat_id, mode,
    style = 'sales_neurocopy',
    src_lang = 'ru',
    tgt_lang = 'en',
    text,
    need_ru_echo = true,
    messages = [],
    session = {},
    examples = []
  } = body;

  const model = pickModel(mode);
  const sys = makeSystemPrompt({ language: null, session, examples });

  const baseMsgs = [
    { role: 'system', content: sys },
    // Контекст, если есть
    ...truncateHistory(messages),
    // Задача перевода
    {
      role: 'user',
      content:
`Задача: сделай убедительный, естественный перевод на ${tgt_lang.toUpperCase()} с элементами нейрокопирайтинга (ясность, выгоды, снятие тревог, мягкий CTA), без воды и без перечисления правил.
Исходный текст (${src_lang.toUpperCase()}): 
${text}

Требования:
- Итог только на целевом языке (без пояснений, без двойных версий).
- Короткие абзацы, чистая пунктуация, деловой, человечный тон WhatsApp.
- Без эмодзи, если явно не уместны.`
    }
  ];

  // 1-й вызов: целевой язык
  const r1 = await runLLM({ model, messages: baseMsgs });
  if (!r1.ok) return r1;

  let ru_echo = null;
  if (need_ru_echo) {
    const sys2 = makeSystemPrompt({ language: 'ru', session, examples });
    const msgs2 = [
      { role: 'system', content: sys2 },
      { role: 'user', content:
`Сделай грамотную русскую версию (не дословный back-translation, а аккуратный перефраз результата ниже).
Сохрани смысл, тон и структуру. Никаких пояснений.
Текст на ${tgt_lang.toUpperCase()}:
${r1.text}` }
    ];
    const r2 = await runLLM({ model, messages: msgs2 });
    if (r2.ok) ru_echo = r2.text;
  }

  return { ok: true, model: r1.model, reply: r1.text, ru_echo };
}

// 5.2 Русская версия
async function handleRewriteRu(body) {
  const { mode, text, messages = [], session = {}, examples = [], note = '' } = body;
  const model = pickModel(mode);
  const sys = makeSystemPrompt({ language: 'ru', session, examples });

  const msgs = [
    { role: 'system', content: sys },
    ...truncateHistory(messages),
    { role: 'user', content:
`Сделай чистую, грамотную русскую версию текста ниже. Смысл и структура сохраняются, стиль деловой, человечный.
${note ? `Заметка: ${note}` : ''}
Текст:
${text}

Требования:
- Без пояснений и метаданных.
- Корректная пунктуация, короткие абзацы.` }
  ];

  const r = await runLLM({ model, messages: msgs });
  if (!r.ok) return r;
  return { ok: true, model: r.model, reply: r.text };
}

// 5.3 Пересборка «продающего» ответа
async function handleRecomposeSales(body) {
  const { mode, text, hints = {}, messages = [], session = {}, examples = [] } = body;
  const model = pickModel(mode);
  const sys = makeSystemPrompt({ language: 'ru', session, examples });

  const wantsPsy = hints.psychology !== false;
  const wantsNeuro = hints.neurocopy !== false;
  const wantsCTA = hints.cta_micro !== false;

  const msgs = [
    { role: 'system', content: sys },
    ...truncateHistory(messages),
    { role: 'user', content:
`Пересобери текст в сильный, продающий ответ для B2B-переписки (WhatsApp/Telegram).
${wantsPsy ? '— Используй мягкие психологические триггеры (снятие рисков, уверенность, социальное доказательство).' : ''}
${wantsNeuro ? '— Нейрокопирайтинг: конкретика, выгоды, доведение до действия без давления.' : ''}
${wantsCTA ? '— Заверши микро-CTA (1 короткая фраза).' : ''}

Требования:
- Короткие абзацы, грамотная пунктуация, без воды.
- Никаких преамбул и «вот ваш переписанный текст».
Исходник:
${text}` }
  ];

  const r = await runLLM({ model, messages: msgs });
  if (!r.ok) return r;
  return { ok: true, model: r.model, reply: r.text };
}

/* ──────────────────────────────────────────────────────────────
   ЧАСТЬ 6. ЧАТ-РЕЖИМЫ (НОВЫЙ И СТАРЫЙ)
   ────────────────────────────────────────────────────────────── */

async function handleChatNew(body) {
  const { mode, messages, session = {}, examples = [], language } = body;
  const model = pickModel(mode);
  const sys = makeSystemPrompt({ language, session, examples });

  const msgs = [
    { role: 'system', content: sys },
    ...truncateHistory(messages)
  ];
  const r = await runLLM({ model, messages: msgs });
  if (!r.ok) return r;
  return { ok: true, model: r.model, reply: r.text };
}

async function handleChatLegacy(body) {
  const { mode, message, history = [], language } = body;
  const model = pickModel(mode);

  const msgs = [
    { role: 'system', content: SYSTEM_PROMPT + (language ? `\nОтвечай на языке: ${language}` : '') },
    ...truncateHistory(history),
    { role: 'user', content: message }
  ];
  const r = await runLLM({ model, messages: msgs });
  if (!r.ok) return r;
  return { ok: true, model: r.model, reply: r.text };
}

/* ──────────────────────────────────────────────────────────────
   ЧАСТЬ 7. РОУТЫ: HEALTH, PING, REPLY
   ────────────────────────────────────────────────────────────── */

app.get('/', (_, res) => res.type('text/plain').send('OK Renovogo backend'));
app.get('/health', (_, res) => res.json({ ok: true, model: MODEL_PRIMARY }));
app.get('/api/ping', (_, res) => res.json({ ok: true, ts: Date.now(), model: MODEL_PRIMARY }));

app.post('/api/reply', async (req, res) => {
  let body;
  try {
    body = BodySchema.parse(req.body);
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'Bad request', details: e.errors });
  }

  try {
    // Action-ветка
    if ('action' in body) {
      switch (body.action) {
        case 'translate': {
          const r = await handleTranslate(body);
          if (!r.ok) return res.status(500).json(r);
          return res.json({ ok: true, model: r.model, reply: r.reply, ru_echo: r.ru_echo });
        }
        case 'rewrite_ru': {
          const r = await handleRewriteRu(body);
          if (!r.ok) return res.status(500).json(r);
          return res.json({ ok: true, model: r.model, reply: r.reply });
        }
        case 'recompose_sales': {
          const r = await handleRecomposeSales(body);
          if (!r.ok) return res.status(500).json(r);
          return res.json({ ok: true, model: r.model, reply: r.reply });
        }
        default:
          return res.status(400).json({ ok: false, error: 'Unknown action' });
      }
    }

    // Новый формат (messages + session + examples)
    if ('messages' in body) {
      const r = await handleChatNew(body);
      if (!r.ok) return res.status(500).json(r);
      return res.json({ ok: true, model: r.model, reply: r.reply });
    }

    // Старый формат (message + history)
    const r = await handleChatLegacy(body);
    if (!r.ok) return res.status(500).json(r);
    return res.json({ ok: true, model: r.model, reply: r.reply });

  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Unhandled', details: String(err?.message || err) });
  }
});

/* ──────────────────────────────────────────────────────────────
   ЧАСТЬ 8. 404 И СТАРТ
   ────────────────────────────────────────────────────────────── */

app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Not Found', path: `${req.method} ${req.originalUrl}` });
});

app.listen(PORT, () => {
  console.log(`[renovogo-backend] http://localhost:${PORT}  model=${MODEL_PRIMARY}`);
});
