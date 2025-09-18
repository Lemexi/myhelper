// server.js — RenovoGo Bot v2 (Neon + Telegram + KB-first + stateless commands)

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';

import { tgSend } from './src/telegram.js';
import { pool, upsertSession } from './src/db.js'; // твои существующие модули
// В reply.js лежит вся бизнес-логика: smartReply, oneShotTeach, oneShotTranslate
// Импорты делаем "лениво" внутри хендлеров, чтобы горячие деплои были мягче.

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));
app.use(cors({ origin: true }));

// ── ENV ───────────────────────────────────────────────────────────────────────
const PORT           = process.env.PORT || 8080;
const TZ             = process.env.TZ || 'Europe/Warsaw';
const BOT_TOKEN      = process.env.BOT_TOKEN || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'dev';

console.log('▶ Timezone:', TZ);
console.log('▶ Expected webhook path:', `/telegram/${WEBHOOK_SECRET}`);
console.log('▶ Features: /teach(last bot reply), /translate, KB-first answers');

if (!process.env.DATABASE_URL) console.warn('⚠ DATABASE_URL not set');
if (!BOT_TOKEN)                 console.warn('⚠ BOT_TOKEN not set');

// ── ПИНГ/ХЭЛС ────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send('RenovoGo Bot is up'));

app.get('/api/ping', (req, res) => {
  res.json({
    ok: true,
    ts: Date.now(),
    env: {
      has_DB: !!process.env.DATABASE_URL,
      has_BOT: !!BOT_TOKEN,
      webhook: `/telegram/${WEBHOOK_SECRET}`,
    },
  });
});

app.get('/debug/webhook', (req, res) =>
  res.json({ ok: true, expected_path: `/telegram/${WEBHOOK_SECRET}` })
);

app.get('/debug/memory', async (req, res) => {
  res.json({ ok: true, note: 'Using Neon (Postgres) for memory & KB' });
});

// Экспорт истории сессии (как у тебя было)
app.get('/api/export/:sessionKey', async (req, res) => {
  try {
    const sessionKey = req.params.sessionKey;
    const sessionId = await upsertSession(sessionKey, 'unknown');
    const q = `
      SELECT role, content, created_at
        FROM messages
       WHERE session_id = $1
       ORDER BY id ASC
    `;
    const { rows } = await pool.query(q, [sessionId]);
    res.json({ ok: true, session: sessionKey, messages: rows });
  } catch (e) {
    console.error('/api/export error', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// HTTP API для фронта (если нужно с сайта)
app.post('/api/reply', async (req, res) => {
  const { session_id = 'web:local', channel = 'site', text = '', lang = 'ru' } = req.body || {};
  if (!text) return res.status(400).json({ ok: false, error: 'text required' });

  try {
    const { smartReply } = await import('./src/reply.js');
    const out = await smartReply(session_id, channel, text, lang);
    res.json({ ok: true, text: out });
  } catch (e) {
    console.error('/api/reply error', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── TELEGRAM WEBHOOK (СТАТЛЕСС-КОМАНДЫ + «ЖИВОЙ» РЕЖИМ) ─────────────────────
app.get(`/telegram/${WEBHOOK_SECRET}`, (req, res) => {
  res.json({ ok: true, via: 'GET', expected: `/telegram/${WEBHOOK_SECRET}` });
});

app.post(`/telegram/${WEBHOOK_SECRET}`, async (req, res) => {
  try {
    const update = req.body;
    const msg = update?.message || update?.edited_message || update?.channel_post;
    if (!msg) return res.status(200).json({ ok: true });

    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const text = (msg.text || msg.caption || '').trim();

    // 1) статлесс-команды: выполняем и СРАЗУ выходим (никаких режимов)
    if (text.startsWith('/')) {
      const [cmd, ...rest] = text.split(' ');
      const payload = rest.join(' ').trim();

      try {
        if (cmd === '/start') {
          await tgSend(chatId, 'Привет! Я на связи.');
        } else if (cmd === '/teach') {
          const { oneShotTeach } = await import('./src/reply.js');
          const out = await oneShotTeach({ chatId, userId, payload });
          await tgSend(chatId, out); // "✅ В базу добавлено."
        } else if (cmd === '/translate') {
          const { oneShotTranslate } = await import('./src/reply.js');
          const out = await oneShotTranslate({ chatId, userId, text }); // весь /translate ...
          await tgSend(chatId, out); // чистый перевод (без «вот перевод»)
        } else {
          await tgSend(chatId, 'Неизвестная команда.');
        }
      } catch (e) {
        console.error('Command error', e);
        await tgSend(chatId, 'Команда не выполнена.');
      }
      // Telegram ждёт 200 в любом случае, чтобы не было дублей
      return res.status(200).json({ ok: true });
    }

    // 2) обычные сообщения — «живой» режим (KB-first)
    try {
      const { smartReply } = await import('./src/reply.js');
      const answer = await smartReply(`tg:${chatId}`, 'telegram', text, 'ru');
      await tgSend(chatId, answer);
    } catch (e) {
      console.error('smartReply error', e);
      await tgSend(chatId, 'Извини, у меня сейчас заминка.');
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Telegram webhook error', e);
    // Всё равно 200 — иначе ТГ начнёт ретраи
    res.status(200).json({ ok: true });
  }
});

// ── ЗАПУСК ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`▶ RenovoGo Bot listening on :${PORT}`);
});