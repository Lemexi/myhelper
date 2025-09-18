// server.js — RenovoGo Bot v0.2
// Архитектура: Express + Telegram Webhook + Groq LLM + RAM memory
// Node >= 18 (есть глобальный fetch)
// ──────────────────────────────────────────────────────────────────────────────

/* ╔══════════════════════════════════════════════════════════════════════════╗
   ║ 0) ИМПОРТЫ, БАЗОВАЯ НАСТРОЙКА                                          ║
   ╚══════════════════════════════════════════════════════════════════════════╝ */
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { Groq } from 'groq-sdk';
import { SYSTEM_PROMPT } from './prompt.js'; // держим персону отдельно

const app = express();
app.use(express.json({ limit: '1mb' })); // JSON для /api/* и Telegram POST
app.use(cors({ origin: true }));
app.use(morgan('dev'));

const PORT           = process.env.PORT || 8080;
const TZ             = process.env.TZ || 'Europe/Warsaw';
const BOT_TOKEN      = process.env.BOT_TOKEN || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'dev';

// Логируем ожидаемый путь вебхука — чтобы в Render-логах сразу видно было:
console.log('▶ Timezone:', TZ);
console.log('▶ Expected webhook path:', `/telegram/${WEBHOOK_SECRET}`);

/* ╔══════════════════════════════════════════════════════════════════════════╗
   ║ 1) МОДЕЛИ LLM (GROQ)                                                    ║
   ╚══════════════════════════════════════════════════════════════════════════╝ */
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const MODEL_PRIMARY  = process.env.GROQ_MODEL_PRIMARY  || 'llama-3.3-70b-versatile';
const MODEL_FALLBACK = process.env.GROQ_MODEL_FALLBACK || 'llama-3.1-8b-instant';
const MODEL_EXPERT   = process.env.GROQ_MODEL_EXPERT   || 'openai/gpt-oss-120b';

async function runLLM(messages) {
  const models = [MODEL_PRIMARY, MODEL_FALLBACK, MODEL_EXPERT];
  for (const model of models) {
    try {
      const resp = await groq.chat.completions.create({
        model,
        temperature: 0.7,
        top_p: 0.9,
        max_tokens: 400,
        messages,
      });
      const text = resp?.choices?.[0]?.message?.content?.trim();
      if (text) return { model, text };
    } catch (e) {
      console.error('LLM error on', model, e.status || '', e.message);
      // пробуем следующий
    }
  }
  throw new Error('All LLM models failed');
}

/* ╔══════════════════════════════════════════════════════════════════════════╗
   ║ 2) ПАМЯТЬ СЕССИЙ (RAM)                                                  ║
   ╚══════════════════════════════════════════════════════════════════════════╝
   Map<sessionId, Array<{role:'user'|'assistant', content:string, ts:number}>>
   В v1 можно заменить на MySQL/SQLite без изменения публичных API.           */
const memory = new Map();
const MAX_TURNS = 12; // храним последние 12 ходов (user+assistant ~ 24 сообщений)

function pushMsg(sessionId, role, content) {
  const arr = memory.get(sessionId) || [];
  arr.push({ role, content, ts: Date.now() });
  const hardCap = MAX_TURNS * 2;
  memory.set(sessionId, arr.length > hardCap ? arr.slice(-hardCap) : arr);
}

/* ╔══════════════════════════════════════════════════════════════════════════╗
   ║ 3) ЯДРО ОТВЕТА                                                          ║
   ╚══════════════════════════════════════════════════════════════════════════╝ */
async function replyCore(sessionId, userText) {
  const history = memory.get(sessionId) || [];
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: userText },
  ];
  const { model, text } = await runLLM(messages);
  pushMsg(sessionId, 'user', userText);
  pushMsg(sessionId, 'assistant', text);
  return { model, text };
}

/* ╔══════════════════════════════════════════════════════════════════════════╗
   ║ 4) УТИЛИТЫ                                                               ║
   ╚══════════════════════════════════════════════════════════════════════════╝ */
async function tgSend(chatId, text) {
  if (!BOT_TOKEN) throw new Error('BOT_TOKEN not set');
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: false,
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) console.error('Telegram sendMessage failed:', j);
  return j;
}

/* ╔══════════════════════════════════════════════════════════════════════════╗
   ║ 5) HEALTH & DEBUG                                                        ║
   ╚══════════════════════════════════════════════════════════════════════════╝ */
app.get('/', (req, res) => res.send('RenovoGo Bot is up'));
app.get('/api/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

// быстрый просмотр, какой путь вебхука ожидается сервером
app.get('/debug/webhook', (req, res) => {
  res.json({ ok: true, expected_path: `/telegram/${WEBHOOK_SECRET}` });
});

// базовый просмотр объёма памяти (без контента — для безопасности)
app.get('/debug/memory', (req, res) => {
  const stats = [];
  for (const [k, v] of memory.entries()) {
    stats.push({ session: k, messages: v.length, lastTs: v.at(-1)?.ts || null });
  }
  res.json({ ok: true, sessions: stats });
});

/* ╔══════════════════════════════════════════════════════════════════════════╗
   ║ 6) HTTP API ДЛЯ ВЕБ-ФРОНТА (необяз.)                                     ║
   ╚══════════════════════════════════════════════════════════════════════════╝ */
app.post('/api/reply', async (req, res) => {
  const { session_id = 'local', text = '' } = req.body || {};
  if (!text) return res.status(400).json({ ok: false, error: 'text required' });
  try {
    const out = await replyCore(session_id, text);
    res.json({ ok: true, ...out });
  } catch (e) {
    console.error('/api/reply error', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ╔══════════════════════════════════════════════════════════════════════════╗
   ║ 7) TELEGRAM WEBHOOK                                                      ║
   ╚══════════════════════════════════════════════════════════════════════════╝ */
// GET — просто для быстрой проверки из браузера, что путь существует
app.get(`/telegram/${WEBHOOK_SECRET}`, (req, res) => {
  res.json({ ok: true, via: 'GET', expected: `/telegram/${WEBHOOK_SECRET}` });
});

// POST — основной приём апдейтов от Telegram
app.post(`/telegram/${WEBHOOK_SECRET}`, async (req, res) => {
  try {
    const update = req.body;
    const msg = update?.message || update?.edited_message || update?.channel_post;
    if (!msg) return res.status(200).json({ ok: true });

    const chatId = msg.chat.id;
    const text = msg.text || msg.caption || '';

    if (!text) {
      await tgSend(chatId, 'Пока обрабатываю только текст.');
      return res.status(200).json({ ok: true });
    }

    // sessionId строим по chat.id
    const sessionId = `tg:${chatId}`;
    const { text: answer } = await replyCore(sessionId, text);
    await tgSend(chatId, answer);

    // Telegram любит 200 OK быстро, чтобы не ретраить
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Telegram webhook error', e);
    // Всегда 200, иначе Telegram засыпет повторами
    res.status(200).json({ ok: true });
  }
});

/* ╔══════════════════════════════════════════════════════════════════════════╗
   ║ 8) ЗАПУСК СЕРВЕРА                                                        ║
   ╚══════════════════════════════════════════════════════════════════════════╝ */
app.listen(PORT, () => {
  console.log(`▶ RenovoGo Bot listening on :${PORT}`);
});
