// server.js — RenovoGo backend (health, actions, chat, dedupe, classify, answer_on, restart)
// v2025-09-18-3

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
  label: z.string().min(1),          // например: "дорого"
  context: z.string().optional().default(''), // опционально — свежий контекст диалога
  messages: z.array(Msg).optional(),
  session: SessionSchema,
  examples: z.array(ExampleItem).optional().default([]) // сюда index.php кладёт кейсы категории
});

const ActionControl = CommonEnvelope.extend({
  action: z.literal('control'),
  op: z.enum(['restart']).default('restart'),
  chat_id: z.string().optional()
});

// Новый формат чата
const ChatPayloadNew = CommonEnvelope.extend({
  messages: z.array(Msg),
  session: SessionSchema,
  examples: z.array(ExampleItem).optional().default([]),
  language: z.string().optional() // по умолчанию ru
});

// Старый формат (совместимость)
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
   ЧАСТЬ 3. УТИЛИТЫ: модель, история, LLM, хэши
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
    const i = arr.findIndex(m => m.role === 'user' || m.role === 'assistant');
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

function sha1(s) {
  // лёгкий sha1-полифилл не нужен: используем key по сути как строку, цель — кэшировать, не шифровать
  // для простоты «хэш» = первые 64 символа исходной строки (достаточно для анти-повторов)
  return String(s).slice(0, 64);
}

/* ──────────────────────────────────────────────────────────────
   ЧАСТЬ 4. СИСТЕМНЫЙ ПРОМПТ И ШАБЛОНЫ
   ────────────────────────────────────────────────────────────── */

function makeSystemPrompt({ language, session, examples }) {
  const lang = language || 'ru'; // по умолчанию RU, чтобы не «уплывал» в EN
  const lines = [SYSTEM_PROMPT];

  if (session?.persona) lines.push(`\nПерсона: ${session.persona}`);
  if (typeof session?.trust_score === 'number') lines.push(`\nТекущий trust_score: ${session.trust_score}`);
  if (session?.memory && Object.keys(session.memory).length > 0) {
    lines.push(`\nПостоянные предпочтения/память:\n${JSON.stringify(session.memory)}`);
  }
  if (Array.isArray(examples) && examples.length > 0) {
    const filtered = examples.filter(e => e.tag === 'would_answer').slice(0, 12);
    if (filtered.length) {
      lines.push(`\nПримеры стиля (would_answer) — ориентир по тону и структуре (без дословных копий):`);
      for (const ex of filtered) lines.push(`— ${ex.content}`);
    }
  }
  lines.push(`\nОтвечай на языке: ${lang}`);
  return lines.join('\n');
}

function promptTranslate(tgt, src, text) {
  return `Задача: сделай один законченный ответ на ${tgt.toUpperCase()} из текста на ${src.toUpperCase()}.
Стиль: деловой и человечный WhatsApp, нейрокопирайтинг (ясность, выгоды, мягкое снятие рисков, микро-CTA при уместности), без воды.
Формат: только итоговый текст на ${tgt.toUpperCase()} — без пояснений, без второй версии, без постскриптумов.
Текст:
${text}`;
}

function promptRuEcho(tgtText, tgtLang) {
  return `Сделай аккуратную русскую версию текста (${tgtLang.toUpperCase()} → RU), не дословный бэктранслейт.
Смысл и структура сохраняются, стиль деловой и лаконичный, без пояснений.
Текст:
${tgtText}`;
}

function promptRecompose(text, opts) {
  const { psychology = true, neurocopy = true, cta_micro = true } = opts || {};
  return `Пересобери текст в краткий, продающий ответ для B2B-переписки (WhatsApp/Telegram).
${psychology ? '— Используй мягкие психологические триггеры: уверенность, снятие рисков, социальное доказательство.' : ''}
${neurocopy ? '— Нейрокопирайтинг: конкретика, выгоды, фокус на следующем шаге.' : ''}
${cta_micro ? '— Заверши микро-CTA одной короткой фразой.' : ''}

Требования:
- Короткие абзацы, грамотная пунктуация, без вступлений вроде «вот ваш текст».
Исходник:
${text}`;
}

function promptClassify(text, labels, k) {
  return `Классифицируй сообщение по списку меток и верни ${k} самых релевантных.
Метки: ${labels.join(', ')}
Текст: ${text}

Формат ответа:
label1, label2, label3`;
}

function promptAnswerFromCategory(label, examples, context) {
  const lines = [];
  lines.push(`Используй подходящие кейсы этой категории, адаптируй под контекст и дай один готовый ответ.`);
  lines.push(`Категория: ${label}`);
  if (context) lines.push(`Контекст: ${context}`);
  if (examples.length) {
    lines.push(`Кейсы категории (примеры, не копируй дословно):`);
    for (const ex of examples.slice(0, 8)) {
      lines.push(`— ${ex.content}`);
    }
  } else {
    lines.push(`Кейсов нет — сгенерируй аккуратный шаблон по категории.`);
  }
  lines.push(`Требования: кратко, по делу, деловой человечный тон, без преамбул и пояснений, один ответ.`);

  return lines.join('\n');
}

/* ──────────────────────────────────────────────────────────────
   ЧАСТЬ 5. КЭШИ АНТИ-ПОВТОРОВ И RESTART
   ────────────────────────────────────────────────────────────── */

// Анти-дуп по ключу (ретраи клиента/телеграма)
const dupeCache = new Map(); // key -> timestamp
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

// Анти-«зацикливание» по содержимому
const recentByChat = new Map(); // chat_id -> { lastHash, count, ts }
const REPEAT_TTL_MS = 5 * 60_000; // 5 минут
const REPEAT_MAX = 2; // если один и тот же текст прилетает чаще — режем

function isRepeatSuppressed(chat_id, text) {
  if (!chat_id || !text) return false;
  const now = Date.now();
  const key = String(chat_id);
  const h = sha1(text);
  const cur = recentByChat.get(key);
  if (!cur || (now - cur.ts) > REPEAT_TTL_MS) {
    recentByChat.set(key, { lastHash: h, count: 1, ts: now });
    return false;
  }
  if (cur.lastHash === h) {
    cur.count += 1; cur.ts = now;
    recentByChat.set(key, cur);
    return cur.count > REPEAT_MAX;
  } else {
    recentByChat.set(key, { lastHash: h, count: 1, ts: now });
    return false;
  }
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
    chat_id
  } = body;

  // защита от «один и тот же текст 100 раз»
  if (isRepeatSuppressed(chat_id, `translate|${src_lang}|${tgt_lang}|${text}`)) {
    return { ok: false, error: 'repeat_suppressed' };
  }

  const model = pickModel(mode);
  const sys = makeSystemPrompt({ language: null, session, examples });

  const msgs1 = [
    { role: 'system', content: sys },
    ...truncateHistory(messages),
    { role: 'user', content: promptTranslate(tgt_lang, src_lang, text) }
  ];
  const r1 = await runLLM({ model, messages: msgs1 });
  if (!r1.ok) return r1;

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
  const { mode, text, messages = [], session = {}, examples = [], note = '', chat_id } = body;

  if (isRepeatSuppressed(chat_id, `rewrite_ru|${text}`)) {
    return { ok: false, error: 'repeat_suppressed' };
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
  const { mode, text, hints = {}, messages = [], session = {}, examples = [], chat_id } = body;

  if (isRepeatSuppressed(chat_id, `recompose|${text}`)) {
    return { ok: false, error: 'repeat_suppressed' };
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
  const { mode, text, labels, top_k, messages = [], session = {}, examples = [], chat_id } = body;

  if (isRepeatSuppressed(chat_id, `classify|${text}`)) {
    return { ok: false, error: 'repeat_suppressed' };
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
  const { mode, label, context = '', messages = [], session = {}, examples = [], chat_id } = body;

  if (isRepeatSuppressed(chat_id, `answer_on|${label}|${context}`)) {
    return { ok: false, error: 'repeat_suppressed' };
    }

  const model = pickModel(mode);
  const sys = makeSystemPrompt({ language: 'ru', session, examples });

  // отфильтруем кейсы своей категории, которые пришли в payload.examples
  const tag = 'category:' + label.toLowerCase();
  const catExamples = (examples || []).filter(e => e.tag.toLowerCase() === tag);

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
   ЧАСТЬ 7. ЧАТ (НОВЫЙ И СТАРЫЙ)
   ────────────────────────────────────────────────────────────── */

async function handleChatNew(body) {
  const { mode, messages, session = {}, examples = [], language, chat_id } = body;

  if (isRepeatSuppressed(chat_id, `chat_new|${messages?.[messages.length-1]?.content || ''}`)) {
    return { ok: false, error: 'repeat_suppressed' };
  }

  const model = pickModel(mode);
  const sys = makeSystemPrompt({ language, session, examples });

  const msgs = [{ role: 'system', content: sys }, ...truncateHistory(messages)];
  const r = await runLLM({ model, messages: msgs });
  if (!r.ok) return r;
  return { ok: true, model: r.model, reply: r.text };
}

async function handleChatLegacy(body) {
  const { mode, message, history = [], language, chat_id } = body;

  if (isRepeatSuppressed(chat_id, `chat_legacy|${message}`)) {
    return { ok: false, error: 'repeat_suppressed' };
  }

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
  // Анти-дубликаты по dedupe_key
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
          if (!r.ok) return res.status(r.error === 'repeat_suppressed' ? 429 : 500).json(r);
          return res.json({ ok: true, model: r.model, reply: r.reply, ru_echo: r.ru_echo });
        }
        case 'rewrite_ru': {
          const r = await handleRewriteRu(body);
          if (!r.ok) return res.status(r.error === 'repeat_suppressed' ? 429 : 500).json(r);
          return res.json({ ok: true, model: r.model, reply: r.reply });
        }
        case 'recompose_sales': {
          const r = await handleRecomposeSales(body);
          if (!r.ok) return res.status(r.error === 'repeat_suppressed' ? 429 : 500).json(r);
          return res.json({ ok: true, model: r.model, reply: r.reply });
        }
        case 'classify': {
          const r = await handleClassify(body);
          if (!r.ok) return res.status(r.error === 'repeat_suppressed' ? 429 : 500).json(r);
          return res.json({ ok: true, model: r.model, labels: r.reply });
        }
        case 'answer_on': {
          const r = await handleAnswerOn(body);
          if (!r.ok) return res.status(r.error === 'repeat_suppressed' ? 429 : 500).json(r);
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
      if (!r.ok) return res.status(r.error === 'repeat_suppressed' ? 429 : 500).json(r);
      return res.json({ ok: true, model: r.model, reply: r.reply });
    }

    const r = await handleChatLegacy(body);
    if (!r.ok) return res.status(r.error === 'repeat_suppressed' ? 429 : 500).json(r);
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
