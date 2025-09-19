// server.js — RenovoGo Bot v2 (PG + Groq + Telegram + KB/Translate)
// Node >= 18

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';

// core bot logic
import { smartReply } from './src/reply.js';
import { tgSend } from './src/telegram.js';

// DB helpers
import { upsertSession, pool } from './src/db.js';

// admin/knowledge modules
import { addJob, listJobs } from './src/study.js';
import { upsertDemand, setSessionContract } from './src/demand.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));
app.use(cors({ origin: true }));

// ─────────────────────────────────────────────────────────────
// ENV
// ─────────────────────────────────────────────────────────────
const PORT            = process.env.PORT || 8080;
const TZ              = process.env.TZ || 'Europe/Warsaw';
const BOT_TOKEN       = process.env.BOT_TOKEN || '';
const WEBHOOK_SECRET  = process.env.WEBHOOK_SECRET || 'dev';
const ADMIN_TOKEN     = process.env.ADMIN_TOKEN || ''; // для /api/admin/*

console.log('▶ Timezone:', TZ);
console.log('▶ Expected webhook path:', `/telegram/${WEBHOOK_SECRET}`);
if (!process.env.DATABASE_URL) console.warn('⚠ DATABASE_URL not set');
if (!process.env.GROQ_API_KEY) console.warn('⚠ GROQ_API_KEY not set');
if (!BOT_TOKEN) console.warn('⚠ BOT_TOKEN not set');
if (!ADMIN_TOKEN) console.warn('⚠ ADMIN_TOKEN not set (admin endpoints disabled)');

// ─────────────────────────────────────────────────────────────
// HEALTH / DEBUG
// ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send('RenovoGo Bot is up'));

app.get('/api/ping', (req, res) => {
  res.json({
    ok: true,
    ts: Date.now(),
    env: {
      has_DB: !!process.env.DATABASE_URL,
      has_GROQ: !!process.env.GROQ_API_KEY,
      has_BOT: !!BOT_TOKEN,
      webhook: `/telegram/${WEBHOOK_SECRET}`
    }
  });
});

app.get('/debug/webhook', (req, res) =>
  res.json({ ok: true, expected_path: `/telegram/${WEBHOOK_SECRET}` })
);

app.get('/debug/memory', async (_req, res) => {
  res.json({ ok: true, note: 'Using Postgres for memory (sessions/messages/…)' });
});

// Экспорт истории сессии (по session_key)
app.get('/api/export/:sessionKey', async (req, res) => {
  try {
    const sessionKey = req.params.sessionKey;
    const sessionId = await upsertSession(sessionKey, 'unknown');
    const q = `
      SELECT role, content, created_at
      FROM public.messages
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

// ─────────────────────────────────────────────────────────────
// PUBLIC API — reply from site/app
// ─────────────────────────────────────────────────────────────
app.post('/api/reply', async (req, res) => {
  const {
    session_id = 'web:local',
    channel = 'site',
    text = '',
    lang = 'ru',
    meta = {} // опционально: { nameFromClient: '…', countryHint: 'CZ', ... }
  } = req.body || {};

  if (!text) return res.status(400).json({ ok: false, error: 'text required' });

  try {
    // smartReply сам: сохранит сообщение, подберёт имя/факты, сводки, стиль, KB и т.д.
    const out = await smartReply(session_id, channel, text, lang, { meta });

    if (Array.isArray(out)) return res.json({ ok: true, texts: out });
    return res.json({ ok: true, text: out });
  } catch (e) {
    console.error('/api/reply error', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// TELEGRAM WEBHOOK
// ─────────────────────────────────────────────────────────────
app.get(`/telegram/${WEBHOOK_SECRET}`, (_req, res) => {
  res.json({ ok: true, via: 'GET', expected: `/telegram/${WEBHOOK_SECRET}` });
});

app.post(`/telegram/${WEBHOOK_SECRET}`, async (req, res) => {
  try {
    const update = req.body;
    const msg = update?.message || update?.edited_message || update?.channel_post;
    if (!msg) return res.status(200).json({ ok: true });

    const chatId = msg.chat.id;
    const text   = msg.text || msg.caption || '';
    if (!text) {
      await tgSend(chatId, 'Пока обрабатываю только текст.');
      return res.status(200).json({ ok: true });
    }

    // передаём Telegram-метаданные, чтобы внутри smartReply можно было записать имя
    const tgMeta = {
      from: msg.from,
      chat: msg.chat,
      message_id: msg.message_id
    };

    const answer = await smartReply(`tg:${chatId}`, 'telegram', text, 'ru', { tgMeta });

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
    // Telegram ждёт 200 в любом случае, чтобы не ретраить бесконечно
    res.status(200).json({ ok: true });
  }
});

// ─────────────────────────────────────────────────────────────
// ADMIN API (защищено токеном) — Изучи/DEMAND/Контракты
// ─────────────────────────────────────────────────────────────
function guardAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(403).json({ ok: false, error: 'ADMIN_TOKEN not configured' });
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== ADMIN_TOKEN) return res.status(401).json({ ok: false, error: 'unauthorized' });
  next();
}

// список контрактов (из справочника)
app.get('/api/admin/contracts', guardAdmin, async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT id, country, code, label, duration_months, price_base, currency, is_active, is_default
    FROM public.contract_catalog
    ORDER BY country, code
  `);
  res.json({ ok: true, items: rows });
});

// создать/обновить оффер (DEMAND) и optionally привязать контракт
app.post('/api/admin/demand', guardAdmin, async (req, res) => {
  try {
    const { session_key, payload = {}, contract_code = null } = req.body || {};
    if (!session_key) return res.status(400).json({ ok: false, error: 'session_key required' });

    const sessionId = await upsertSession(session_key, 'admin');

    const demandId = await upsertDemand(sessionId, payload);

    if (contract_code) {
      const { rows } = await pool.query(
        `SELECT id FROM public.contract_catalog WHERE code = $1 AND is_active = true LIMIT 1`,
        [contract_code]
      );
      if (!rows.length) return res.status(400).json({ ok: false, error: 'contract_code not found/active' });
      await setSessionContract(sessionId, demandId, rows[0].id, payload.override || {});
    }

    res.json({ ok: true, session_id: sessionId, demand_id: demandId });
  } catch (e) {
    console.error('/api/admin/demand error', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// добавить вакансию в «Изучи»
app.post('/api/admin/jobs', guardAdmin, async (req, res) => {
  try {
    const { title, country, city, salary, hours, notes } = req.body || {};
    if (!title) return res.status(400).json({ ok: false, error: 'title required' });
    const id = await addJob({ title, country, city, salary, hours, notes });
    res.json({ ok: true, id });
  } catch (e) {
    console.error('/api/admin/jobs error', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// список вакансий (каталог «Изучи»)
app.get('/api/admin/jobs', guardAdmin, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const items = await listJobs(limit);
    res.json({ ok: true, items });
  } catch (e) {
    console.error('/api/admin/jobs list error', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`▶ RenovoGo Bot listening on :${PORT}`);
  console.log(`▶ Telegram webhook: /telegram/${WEBHOOK_SECRET}`);
});
