// server.js — RenovoGo Bot v2 (PG + Groq + Telegram + KB/Translate)
// Node >= 18

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';

import { smartReply } from './src/reply.js';
import { tgSend } from './src/telegram.js';
import { upsertSession, pool } from './src/db.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));
app.use(cors({ origin: true }));

const PORT           = process.env.PORT || 8080;
const TZ             = process.env.TZ || 'Europe/Warsaw';
const BOT_TOKEN      = process.env.BOT_TOKEN || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'dev';

console.log('▶ Timezone:', TZ);
console.log('▶ Expected webhook path:', `/telegram/${WEBHOOK_SECRET}`);
if (!process.env.DATABASE_URL) console.warn('⚠ DATABASE_URL not set');
if (!process.env.GROQ_API_KEY) console.warn('⚠ GROQ_API_KEY not set');
if (!BOT_TOKEN) console.warn('⚠ BOT_TOKEN not set');

// 1) HEALTH / DEBUG
app.get('/', (req, res) => res.send('RenovoGo Bot is up'));

app.get('/api/ping', (req, res) => {
  res.json({ ok: true, ts: Date.now(), env: {
    has_DB: !!process.env.DATABASE_URL,
    has_GROQ: !!process.env.GROQ_API_KEY,
    has_BOT: !!BOT_TOKEN,
    webhook: `/telegram/${WEBHOOK_SECRET}`
  }});
});

app.get('/debug/webhook', (req, res) =>
  res.json({ ok: true, expected_path: `/telegram/${WEBHOOK_SECRET}` })
);

app.get('/debug/memory', async (req, res) => {
  res.json({ ok: true, note: 'Using Postgres for memory' });
});

// Экспорт истории сессии
app.get('/api/export/:sessionKey', async (req, res) => {
  try {
    const sessionKey = req.params.sessionKey;
    const sessionId = await upsertSession(sessionKey, 'unknown');
    const q = `
      SELECT role, content, created_at
      FROM messages
      WHERE session_id=$1
      ORDER BY id ASC
    `;
    const { rows } = await pool.query(q, [sessionId]);
    res.json({ ok: true, session: sessionKey, messages: rows });
  } catch (e) {
    console.error('/api/export error', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 2) HTTP API
app.post('/api/reply', async (req, res) => {
  const { session_id = 'web:local', channel = 'site', text = '', lang = 'ru' } = req.body || {};
  if (!text) return res.status(400).json({ ok: false, error: 'text required' });

  try {
    const out = await smartReply(session_id, channel, text, lang);
    // out может быть строкой (старый путь) или массивом сообщений
    if (Array.isArray(out)) return res.json({ ok: true, texts: out });
    return res.json({ ok: true, text: out });
  } catch (e) {
    console.error('/api/reply error', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 3) TELEGRAM WEBHOOK
app.get(`/telegram/${WEBHOOK_SECRET}`, (req, res) => {
  res.json({ ok: true, via: 'GET', expected: `/telegram/${WEBHOOK_SECRET}` });
});

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

    const answer = await smartReply(`tg:${chatId}`, 'telegram', text, 'ru');

    // Если ответ — массив, отправляем по одному сообщению
    if (Array.isArray(answer)) {
      for (const piece of answer) {
        if (piece && String(piece).trim()) {
          await tgSend(chatId, piece);
        }
      }
    } else {
      await tgSend(chatId, answer);
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Telegram webhook error', e);
    res.status(200).json({ ok: true });
  }
});

// 4) START
app.listen(PORT, () => {
  console.log(`▶ RenovoGo Bot listening on :${PORT}`);
});