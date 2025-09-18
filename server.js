// server.js — RenovoGo backend (health, actions, chat, dedupe, classify, answer_on, restart)
// v2025-09-18-6

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { z } from 'zod';
import { Groq } from 'groq-sdk';
import { SYSTEM_PROMPT } from './prompt.js';

/* ──────────────────────────────────────────────────────────────
   ЧАСТЬ 1. APP, ENV, МОДЕЛИ
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

const MAX_CONTEXT_CHARS = Number(process.env.MAX_CONTEXT_CHARS || 12000);

/* ──────────────────────────────────────────────────────────────
   ЧАСТЬ 2. СХЕМЫ ZOD
   ────────────────────────────────────────────────────────────── */

const Msg = z.object({
  role: z.enum(['system','user','assistant']),
  content: z.string().min(1)
});

const SessionSchema = z.object({
  trust_score: z.number().optional().default(0),
  memory: z.record(z.any()).optional(),
  persona: z.string().optional().default('Victor/Manager')
}).optional().default({ trust_score: 0, persona: 'Victor/Manager' });

const ExampleItem = z.object({
  tag: z.string().min(1),
  content: z.string().min(1),
});

const CommonEnvelope = z.object({
  chat_id: z.string().optional(),
  mode: z.enum(['auto','expert','fallback']).optional().default('auto'),
  dedupe_key: z.string().optional()
});

const ActionTranslate = CommonEnvelope.extend({
  action: z.literal('translate'),
  style: z.string().optional().default('sales_neurocopy'),
  src_lang: z.string().optional().default('ru'),
  tgt_lang: z.string().optional().default('en'),
  text: z.string().min(1),
  need_ru_echo: z.boolean().optional().default(true),
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

const ActionClassify = CommonEnvelope.extend({
  action: z.literal('classify'),
  text: z.string().min(1),
  labels: z.array(z.string()).optional().default([
    'дорого', 'после визы', 'позже', 'нет кандидатов', 'нет слотов', 'запрос документов',
    'гарантии', 'качество кандидатов', 'условия оплаты', 'скидка', 'логистика/жильё'
  ]),
  top_k: z.number().optional().default(3),
  messages: z.array(Msg).optional(),
  session: SessionSchema,
  examples: z.array(ExampleItem).optional().default([])
});

const ActionAnswerOn = CommonEnvelope.extend({
  action: z.literal('answer_on'),
  label: z.string().min(1),
  context: z.string().optional().default(''),
  messages: z.array(Msg).optional(),
  session: SessionSchema,
  examples: z.array(ExampleItem).optional().default([])
});

const ActionControl = CommonEnvelope.extend({
  action: z.literal('control'),
  op: z.enum(['restart']).default('restart'),
  chat_id: z.string().optional()
});

const ChatPayloadNew = CommonEnvelope.extend({
  messages: z.array(Msg),
  session: SessionSchema,
  examples: z.array(ExampleItem).optional().default([]),
  language: z.string().optional()
});

const ChatPayloadLegacy = CommonEnvelope.extend({
  message: z.string().min(1),
  history: z.array(Msg).optional().default([]),
  language: z.string().optional()
});

const BodySchema = z.union([
  ActionTranslate,
  ActionRewriteRu,
  ActionRecomposeSales,
  ActionClassify,
  ActionAnswerOn,
  ActionControl,
  ChatPayloadNew,
  ChatPayloadLegacy
]);

/* ──────────────────────────────────────────────────────────────
   ЧАСТЬ 3. УТИЛИТЫ
   ────────────────────────────────────────────────────────────── */

function pickModel(mode) {
  if (mode === 'expert')   return MODEL_EXPERT;
  if (mode === 'fallback') return MODEL_FALLBACK;
  return MODEL_PRIMARY;
}

function truncateHistory(history = [], maxChars = MAX_CONTEXT_CHARS) {
  const arr = [...history];
  let total = arr.reduce((n, m) => n + (m.content?.length || 0), 0);
  while (total > maxChars && arr.length > 0) {
    const i = arr.findIndex(m => m.role === 'user' или m.role === 'assistant');
    arr.splice(i >= 0 ? i : 0, 1);
    total = arr.reduce((n, m) => n + (m.content?.length || 0), 0);
  }
  return arr;
}

async function runLLM({ model, messages, temperature = TEMPERATURE, top_p = TOP_P, max_tokens = REPLY_MAX_TOKENS }) {
  try {
    const resp = await groq.chat.completions.create({ model, messages, temperature, top_p, max_tokens });
    const text = resp.choices?.[0]?.message?.content?.trim() || '';
    return { ok: true, model, text };
  } catch (err) {
    if (model !== MODEL_FALLBACK) {
      try {
        const resp2 = await groq.chat.completions.create({ model: MODEL_FALLBACK, messages, temperature, top_p, max_tokens });
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
   ЧАСТЬ 4. ПРОМПТЫ
   ────────────────────────────────────────────────────────────── */

function makeSystemPrompt({ language, session, examples }) {
  const lang = language || 'ru';
  const lines = [SYSTEM_PROMPT];

  if (session?.persona) lines.push(`\nПерсона: ${session.persona}`);
  if (typeof session?.trust_score === 'number') lines.push(`\nТекущий trust_score: ${session.trust_score}`);
  if (session?.memory && Object.keys(session.memory).length > 0) {
    lines.push(`\nПостоянные предпочтения/память:\n${JSON.stringify(session.memory)}`);
  }
  if (Array.isArray(examples) && examples.length > 0) {
    const filtered = examples.filter(e => e.tag === 'would_answer').slice(0, 12);
    if (filtered.length) {
      lines.push(`\nПримеры стиля (would_answer) — ориентир по тону и структуре:`);
      for (const ex of filtered) lines.push(`— ${ex.content}`);
    }
  }
  lines.push(`\nОтвечай на языке: ${lang}`);
  return lines.join('\n');
}

// СТРОГИЙ перевод без добавления новой информации
function promptTranslate(tgt, src, text) {
  return `Переведи с ${src.toUpperCase()} на ${tgt.toUpperCase()} и слегка отполируй под деловую переписку WhatsApp.

Правила строго:
— НЕ добавляй новой информации, географии, сроков, цен, ограничений и вопросов, которых нет в оригинале.
— Сохраняй смысл 1:1; допустима только естественная перефразировка на ${tgt.toUpperCase()}.
— Тон: профессиональный, дружелюбный, уверенный. Без эмодзи и без служебных префиксов.
— Объём: 1–3 коротких фразы. Верни только итоговый текст на ${tgt.toUpperCase()}.

Текст:
${text}`;
}

function promptPolishTgt(tgtLang, text) {
  return `Слегка отредактируй текст на ${tgtLang.toUpperCase()} для деловой переписки: яснее и естественнее.
НИЧЕГО не добавляй по смыслу. Без эмодзи и без новых вопросов. Верни только итоговый текст.
Текст:
${text}`;
}

function promptRuEcho(tgtText, tgtLang) {
  return `Сделай аккуратную русскую версию текста (${tgtLang.toUpperCase()} → RU), не дословный бэктранслейт.
Стиль деловой и лаконичный, без пояснений. Верни только текст.
Текст:
${tgtText}`;
}

function promptRecompose(text, opts) {
  const { psychology = true, neurocopy = true, cta_micro = true } = opts || {};
  return `Пересобери текст в краткий, продающий ответ для B2B-переписки (WhatsApp/Telegram).
${psychology ? '— Используй уверенный тон и мягкие триггеры.' : ''}
${neurocopy ? '— Конкретика и выгоды, без воды.' : ''}
${cta_micro ? '— Заверши микро-CTA.' : ''}

Исходник:
${text}`;
}
function promptClassify(text, labels, k) {
  return `Классифицируй сообщение по списку меток и верни ${k} самых релевантных.
Метки: ${labels.join(', ')}
Текст: ${text}
Формат: label1, label2, label3`;
}
function promptAnswerFromCategory(label, examples, context) {
  const lines = [];
  lines.push(`Сформируй один готовый ответ по категории.`);
  lines.push(`Категория: ${label}`);
  if (context) lines.push(`Контекст: ${context}`);
  if (examples.length) {
    lines.push(`Кейсы (не копируй дословно):`);
    for (const ex of examples.slice(0, 8)) lines.push(`— ${ex.content}`);
  } else {
    lines.push(`Кейсов нет — сгенерируй внятный шаблон по категории.`);
  }
  lines.push(`Требования: кратко, по делу, деловой тон, один ответ без пояснений.`);
  return lines.join('\n');
}

/* ──────────────────────────────────────────────────────────────
   ЧАСТЬ 5. АНТИ-ПОВТОРЫ (ослаблено)
   ────────────────────────────────────────────────────────────── */

const dupeCache = new Map();      // dedupe_key → ts
const DUPE_TTL_MS = 30_000;

function isDuplicate(key) {
  if (!key) return false;
  const now = Date.now();
  const ts = dupeCache.get(key);
  for (const [k, t] of dupeCache) if (now - t > DUPE_TTL_MS) dupeCache.delete(k);
  if (ts && (now - ts) < DUPE_TTL_MS) return true;
  dupeCache.set(key, now);
  return false;
}

// мягкое подавление одинаковых payload’ов (кроме chat_new и answer_on)
const recentByChat = new Map(); // chat_id -> { lastKey, count, ts }
const REPEAT_TTL_MS = 120_000;  // 2 минуты
const REPEAT_MAX    = 8;        // допускаем до 8 повторов

function shouldSuppress(chat_id, key, { allow } = { allow: [] }) {
  if (!chat_id || !key) return false;
  if (allow.includes('always')) return false;

  const now = Date.now();
  const cur = recentByChat.get(chat_id) || { lastKey: '', count: 0, ts: 0 };
  if ((now - cur.ts) > REPEAT_TTL_MS) {
    recentByChat.set(chat_id, { lastKey: key, count: 1, ts: now });
    return false;
  }
  if (cur.lastKey === key) {
    cur.count += 1; cur.ts = now; recentByChat.set(chat_id, cur);
    return cur.count > REPEAT_MAX;
  }
  recentByChat.set(chat_id, { lastKey: key, count: 1, ts: now });
  return false;
}

function hardRestart(chat_id) {
  if (chat_id) recentByChat.delete(String(chat_id));
  dupeCache.clear();
}

/* ──────────────────────────────────────────────────────────────
   ЧАСТЬ 6. ACTION HANDLERS
   ────────────────────────────────────────────────────────────── */

async function handleTranslate(body) {
  const {
    mode, style = 'sales_neurocopy',
    src_lang = 'ru',
    tgt_lang = 'en',
    text,
    need_ru_echo = true,
    messages = [],
    session = {},
    examples = [],
    chat_id = ''
  } = body;

  const suppressKey = `translate|${src_lang}|${tgt_lang}|${text}`;
  if (shouldSuppress(chat_id, suppressKey)) {
    return { ok: true, model: MODEL_PRIMARY, reply: 'Повтор того же запроса. Вот готовый вариант на прошлой версии ответа:\n' + text };
  }

  const model = pickModel(mode);
  const sys = makeSystemPrompt({ language: null, session, examples });

  // строгий первичный перевод
  const msgs1 = [
    { role: 'system', content: sys },
    ...truncateHistory(messages),
    { role: 'user', content: promptTranslate(tgt_lang, src_lang, text) }
  ];
  const r1 = await runLLM({ model, messages: msgs1 });
  if (!r1.ok) return r1;

  // лёгкий полишер без изменения смысла
  const msgs1p = [
    { role: 'system', content: sys },
    { role: 'user', content: promptPolishTgt(tgt_lang, r1.text) }
  ];
  const r1p = await runLLM({ model, messages: msgs1p });
  if (r1p.ok && r1p.text) r1.text = r1p.text;

  let ru_echo = null;
  if (need_ru_echo) {
    const sys2 = makeSystemPrompt({ language: 'ru', session, examples });
    const msgs2 = [
      { role: 'system', content: sys2 },
      { role: 'user', content: promptRuEcho(r1.text, tgt_lang) }
    ];
    const r2 = await runLLM({ model, messages: msgs2 });
    if (r2.ok) ru_echo = r2.text;
  }

  return { ok: true, model: r1.model, reply: r1.text, ru_echo };
}

async function handleRewriteRu(body) {
  const { mode, text, messages = [], session = {}, examples = [], note = '', chat_id = '' } = body;

  const suppressKey = `rewrite_ru|${text}`;
  if (shouldSuppress(chat_id, suppressKey)) {
    return { ok: true, model: MODEL_PRIMARY, reply: text };
  }

  const model = pickModel(mode);
  const sys = makeSystemPrompt({ language: 'ru', session, examples });

  const msgs = [
    { role: 'system', content: sys },
    ...truncateHistory(messages),
    { role: 'user', content: `${note ? `Заметка: ${note}\n` : ''}${promptRuEcho(text, 'EN')}` }
  ];
  const r = await runLLM({ model, messages: msgs });
  if (!r.ok) return r;
  return { ok: true, model: r.model, reply: r.text };
}

async function handleRecomposeSales(body) {
  const { mode, text, hints = {}, messages = [], session = {}, examples = [], chat_id = '' } = body;

  const suppressKey = `recompose|${text}`;
  if (shouldSuppress(chat_id, suppressKey)) {
    return { ok: true, model: MODEL_PRIMARY, reply: text };
  }

  const model = pickModel(mode);
  const sys = makeSystemPrompt({ language: 'ru', session, examples });

  const msgs = [
    { role: 'system', content: sys },
    ...truncateHistory(messages),
    { role: 'user', content: promptRecompose(text, hints) }
  ];
  const r = await runLLM({ model, messages: msgs });
  if (!r.ok) return r;
  return { ok: true, model: r.model, reply: r.text };
}

async function handleClassify(body) {
  const { mode, text, labels, top_k, messages = [], session = {}, examples = [], chat_id = '' } = body;

  const suppressKey = `classify|${text}`;
  if (shouldSuppress(chat_id, suppressKey)) {
    return { ok: true, model: MODEL_PRIMARY, reply: labels.slice(0, top_k) };
  }

  const model = pickModel(mode);
  const sys = makeSystemPrompt({ language: 'ru', session, examples });

  const msgs = [
    { role: 'system', content: sys },
    ...truncateHistory(messages),
    { role: 'user', content: promptClassify(text, labels, top_k) }
  ];
  const r = await runLLM({ model, messages: msgs });
  if (!r.ok) return r;

  const raw = r.text.split(/\s*[,;\n]\s*/).map(s => s.trim()).filter(Boolean);
  const uniq = [];
  for (const x of raw) if (!uniq.includes(x)) uniq.push(x);
  return { ok: true, model: r.model, reply: uniq.slice(0, top_k) };
}

async function handleAnswerOn(body) {
  const { mode, label, context = '', messages = [], session = {}, examples = [], chat_id = '' } = body;

  // ВАЖНО: НЕ подавляем для answer_on
  const model = pickModel(mode);
  const sys = makeSystemPrompt({ language: 'ru', session, examples });

  const tag = 'category:' + label.toLowerCase();
  const catExamples = (examples || []).filter(e => (e.tag || '').toLowerCase() === tag);

  const msgs = [
    { role: 'system', content: sys },
    ...truncateHistory(messages),
    { role: 'user', content: promptAnswerFromCategory(label, catExamples, context) }
  ];
  const r = await runLLM({ model, messages: msgs });
  if (!r.ok) return r;
  return { ok: true, model: r.model, reply: r.text };
}

function handleControlRestart(body) {
  const id = body.chat_id || '';
  hardRestart(id);
  return { ok: true, reply: 'Все, я очнулся.' };
}

/* ──────────────────────────────────────────────────────────────
   ЧАСТЬ 7. ЧАТ
   ────────────────────────────────────────────────────────────── */

async function handleChatNew(body) {
  const { mode, messages, session = {}, examples = [], language } = body;

  // ВАЖНО: НЕ подавляем для обычного диалога
  const model = pickModel(mode);
  const sys = makeSystemPrompt({ language, session, examples });

  const msgs = [{ role: 'system', content: sys }, ...truncateHistory(messages)];
  const r = await runLLM({ model, messages: msgs });
  if (!r.ok) return r;
  return { ok: true, model: r.model, reply: r.text };
}

async function handleChatLegacy(body) {
  const { mode, message, history = [], language } = body;

  // ВАЖНО: НЕ подавляем для обычного диалога
  const model = pickModel(mode);
  const sys = SYSTEM_PROMPT + `\nОтвечай на языке: ${language || 'ru'}`;

  const msgs = [
    { role: 'system', content: sys },
    ...truncateHistory(history),
    { role: 'user', content: message }
  ];
  const r = await runLLM({ model, messages: msgs });
  if (!r.ok) return r;
  return { ok: true, model: r.model, reply: r.text };
}

/* ──────────────────────────────────────────────────────────────
   ЧАСТЬ 8. РОУТЫ
   ────────────────────────────────────────────────────────────── */

app.get('/', (_, res) => res.type('text/plain').send('OK Renovogo backend'));
app.get('/health', (_, res) => res.json({ ok: true, model: MODEL_PRIMARY }));
app.get('/api/ping', (_, res) => res.json({ ok: true, ts: Date.now(), model: MODEL_PRIMARY }));

app.post('/api/reply', async (req, res) => {
  // анти-дубликаты по dedupe_key (НЕ для обычного чата и answer_on — там мы его не шлём)
  const dedupeKey = req.body?.dedupe_key;
  if (isDuplicate(dedupeKey)) {
    return res.status(409).json({ ok: false, error: 'duplicate', dedupe_key: dedupeKey });
  }

  let body;
  try {
    body = BodySchema.parse(req.body);
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'Bad request', details: e.errors });
  }

  try {
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
        case 'classify': {
          const r = await handleClassify(body);
          if (!r.ok) return res.status(500).json(r);
          return res.json({ ok: true, model: r.model, labels: r.reply });
        }
        case 'answer_on': {
          const r = await handleAnswerOn(body);
          if (!r.ok) return res.status(500).json(r);
          return res.json({ ok: true, model: r.model, reply: r.reply });
        }
        case 'control': {
          const r = handleControlRestart(body);
          return res.json({ ok: true, reply: r.reply });
        }
        default:
          return res.status(400).json({ ok: false, error: 'Unknown action' });
      }
    }

    if ('messages' in body) {
      const r = await handleChatNew(body);
      if (!r.ok) return res.status(500).json(r);
      return res.json({ ok: true, model: r.model, reply: r.reply });
    }

    const r = await handleChatLegacy(body);
    if (!r.ok) return res.status(500).json(r);
    return res.json({ ok: true, model: r.model, reply: r.reply });

  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Unhandled', details: String(err?.message || err) });
  }
});

/* ──────────────────────────────────────────────────────────────
   ЧАСТЬ 9. 404 И СТАРТ
   ────────────────────────────────────────────────────────────── */

app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Not Found', path: `${req.method} ${req.originalUrl}` });
});

app.listen(PORT, () => {
  console.log(`[renovogo-backend] http://localhost:${PORT}  model=${MODEL_PRIMARY}`);
});
