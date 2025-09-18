// server.js — RenovoGo Bot v1 (Neon PG + Groq + Telegram + KB/Translate)
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
import pg from 'pg';
import { SYSTEM_PROMPT } from './prompt.js';

const { Pool } = pg;

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cors({ origin: true }));
app.use(morgan('dev'));

const PORT           = process.env.PORT || 8080;
const TZ             = process.env.TZ || 'Europe/Warsaw';
const BOT_TOKEN      = process.env.BOT_TOKEN || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'dev';
const DATABASE_URL   = process.env.DATABASE_URL || '';

console.log('▶ Timezone:', TZ);
console.log('▶ Expected webhook path:', `/telegram/${WEBHOOK_SECRET}`);

/* ╔══════════════════════════════════════════════════════════════════════════╗
   ║ 1) GROQ LLM                                                              ║
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
    }
  }
  throw new Error('All LLM models failed');
}

/* ╔══════════════════════════════════════════════════════════════════════════╗
   ║ 1.5) POSTGRES (Neon)                                                     ║
   ╚══════════════════════════════════════════════════════════════════════════╝ */
const pool = new Pool({
  connectionString: DATABASE_URL, // с sslmode=require
  max: 5,
  idleTimeoutMillis: 30000,
});

async function upsertSession(sessionKey, channel) {
  const sel = 'SELECT id FROM sessions WHERE session_key=$1 LIMIT 1';
  const { rows } = await pool.query(sel, [sessionKey]);
  if (rows.length) return rows[0].id;
  const ins = 'INSERT INTO sessions (session_key, channel) VALUES ($1,$2) RETURNING id';
  const insRes = await pool.query(ins, [sessionKey, channel]);
  return insRes.rows[0].id;
}

async function updateContact(sessionId, { name=null, phone=null, locale=null } = {}) {
  const parts = []; const vals = []; let i = 1;
  if (name)  { parts.push(`user_name=$${i++}`);  vals.push(name); }
  if (phone) { parts.push(`user_phone=$${i++}`); vals.push(phone); }
  if (locale){ parts.push(`locale=$${i++}`);    vals.push(locale); }
  if (!parts.length) return;
  vals.push(sessionId);
  const sql = `UPDATE sessions SET ${parts.join(', ')}, updated_at=NOW() WHERE id=$${i}`;
  await pool.query(sql, vals);
}

async function saveMessage(sessionId, role, content, meta=null, lang=null, translated_to=null, translated_content=null, category=null) {
  const q = `
    INSERT INTO messages (session_id, role, content, meta_json, lang, translated_to, translated_content, category)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING id
  `;
  const { rows } = await pool.query(q, [
    sessionId, role, content,
    meta ? JSON.stringify(meta) : null,
    lang, translated_to, translated_content, category
  ]);
  return rows[0]?.id || null;
}

async function loadRecentMessages(sessionId, limit=24) {
  const q = 'SELECT role, content FROM messages WHERE session_id=$1 ORDER BY id DESC LIMIT $2';
  const { rows } = await pool.query(q, [sessionId, limit]);
  return rows.reverse().map(r => ({ role: r.role, content: r.content }));
}

async function loadLatestSummary(sessionId) {
  const q = 'SELECT content FROM summaries WHERE session_id=$1 ORDER BY id DESC LIMIT 1';
  const { rows } = await pool.query(q, [sessionId]);
  return rows.length ? rows[0].content : null;
}

async function saveSummary(sessionId, turnNo, content) {
  const q = `
    INSERT INTO summaries (session_id, turn_no, content)
    VALUES ($1,$2,$3)
    ON CONFLICT (session_id, turn_no) DO UPDATE SET content=EXCLUDED.content
  `;
  await pool.query(q, [sessionId, turnNo, content]);
}

async function logReply(sessionId, strategy, category, kbItemId, messageId=null, notes=null) {
  const q = `
    INSERT INTO reply_audit (session_id, strategy, category, kb_item_id, message_id, notes)
    VALUES ($1,$2,$3,$4,$5,$6)
  `;
  await pool.query(q, [sessionId, strategy, category, kbItemId, messageId, notes]);
}

/* ╔══════════════════════════════════════════════════════════════════════════╗
   ║ 2) КЛАССИФИКАЦИЯ, КЭШ-ПЕРЕВОД, KB                                        ║
   ╚══════════════════════════════════════════════════════════════════════════╝ */
function detectPhone(text) {
  const m = text?.match(/\+?[0-9][0-9 \-()]{6,}/);
  return m ? m[0].replace(/[^\d+]/g,'') : null;
}
function detectName(text) {
  const m = text?.match(/\b(меня зовут|i am|my name is)\s+([A-ZА-ЯЁЇІЄҐ][\p{L}\-']{1,}\s*[A-ZА-ЯЁЇІЄҐ\p{L}\-']*)/iu);
  return m ? m[2].trim() : null;
}
async function classifyCategory(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('дорог') || t.includes('price')) return 'expensive';
  if (t.includes('после виз') || t.includes('after visa')) return 'after_visa';
  if (t.includes('контракт') || t.includes('agreement')) return 'contract';
  if (t.includes('деманд') || t.includes('vacanc')) return 'demands';
  return 'general';
}
async function kbFind(categorySlug, lang) {
  const q = `
    SELECT ki.id, ki.answer FROM kb_items ki
    JOIN kb_categories kc ON kc.id = ki.category_id
    WHERE kc.slug = $1 AND ki.lang = $2 AND ki.is_active = TRUE
    LIMIT 1
  `;
  const { rows } = await pool.query(q, [categorySlug, lang]);
  return rows[0] || null;
}
async function translateCached(text, sourceLang, targetLang) {
  if (!text || sourceLang === targetLang) return { text, cached: true };
  const sel = `
    SELECT translated_text FROM translations_cache
    WHERE source_lang=$1 AND target_lang=$2 AND md5(source_text)=md5($3) LIMIT 1
  `;
  const hit = await pool.query(sel, [sourceLang, targetLang, text]);
  if (hit.rows.length) return { text: hit.rows[0].translated_text, cached: true };

  const { text: translated } = await runLLM([
    { role: 'system', content: 'You are a professional translator. Translate preserving meaning and tone.' },
    { role: 'user', content: `Translate from ${sourceLang} to ${targetLang}: ${text}` }
  ]);

  const ins = `
    INSERT INTO translations_cache (source_text, source_lang, target_lang, translated_text, by_model)
    VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING
  `;
  await pool.query(ins, [text, sourceLang, targetLang, translated, 'groq']);
  return { text: translated, cached: false };
}

/* ╔══════════════════════════════════════════════════════════════════════════╗
   ║ 3) ЯДРО LLM-ОТВЕТА (fallback)                                            ║
   ╚══════════════════════════════════════════════════════════════════════════╝ */
async function replyCore(sessionId, userText) {
  const recent = await loadRecentMessages(sessionId, 24);
  const summary = await loadLatestSummary(sessionId);

  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  if (summary) messages.push({ role: 'system', content: `Краткая сводка прошлой истории:\n${summary}` });
  messages.push(...recent);
  messages.push({ role: 'user', content: userText });

  const { text } = await runLLM(messages);
  return text;
}

/* ╔══════════════════════════════════════════════════════════════════════════╗
   ║ 4) SMART REPLY: приоритет KB → перевод → fallback LLM                    ║
   ╚══════════════════════════════════════════════════════════════════════════╝ */
async function smartReply(sessionKey, channel, userText, userLang='ru') {
  const sessionId = await upsertSession(sessionKey, channel);

  // контакты (если прислали)
  const name = detectName(userText);
  const phone = detectPhone(userText);
  if (name || phone) await updateContact(sessionId, { name, phone });

  // вход
  const userMsgId = await saveMessage(sessionId, 'user', userText, null, userLang, null, null, null);

  // категория
  const category = await classifyCategory(userText);

  // 1) KB на нужном языке
  let kb = await kbFind(category, userLang);
  let answer, strategy = 'fallback_llm', kbItemId = null;

  if (kb) {
    answer = kb.answer;
    strategy = 'kb_hit';
    kbItemId = kb.id;
  } else {
    // 2) KB RU + перевод
    const kbRu = await kbFind(category, 'ru');
    if (kbRu) {
      const { text: translated } = await translateCached(kbRu.answer, 'ru', userLang);
      answer = translated;
      strategy = 'kb_translated';
      kbItemId = kbRu.id;
    }
  }

  // 3) Fallback: LLM
  if (!answer) {
    answer = await replyCore(sessionId, userText);
  }

  // лог стратегии + исход
  await logReply(sessionId, strategy, category, kbItemId, userMsgId, null);
  await saveMessage(sessionId, 'assistant', answer, { category, strategy }, userLang, null, null, category);

  return answer;
}

/* ╔══════════════════════════════════════════════════════════════════════════╗
   ║ 5) УТИЛИТЫ TELEGRAM                                                      ║
   ╚══════════════════════════════════════════════════════════════════════════╝ */
async function tgSend(chatId, text) {
  if (!BOT_TOKEN) throw new Error('BOT_TOKEN not set');
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const body = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: false };
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
   ║ 6) HEALTH & DEBUG                                                        ║
   ╚══════════════════════════════════════════════════════════════════════════╝ */
app.get('/', (req, res) => res.send('RenovoGo Bot is up'));
app.get('/api/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/debug/webhook', (req, res) => res.json({ ok: true, expected_path: `/telegram/${WEBHOOK_SECRET}` }));
app.get('/debug/memory', async (req, res) => {
  // В PG у нас нет «RAM-памяти», оставим заглушку
  res.json({ ok: true, note: 'Using Postgres for memory' });
});

// Экспорт истории сессии (для отладки/аналитики)
app.get('/api/export/:sessionKey', async (req, res) => {
  try {
    const sessionKey = req.params.sessionKey;
    const sessionId = await upsertSession(sessionKey, 'unknown');
    const q = 'SELECT role, content, created_at FROM messages WHERE session_id=$1 ORDER BY id ASC';
    const { rows } = await pool.query(q, [sessionId]);
    res.json({ ok: true, session: sessionKey, messages: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ╔══════════════════════════════════════════════════════════════════════════╗
   ║ 7) HTTP API ДЛЯ ВЕБ-ФРОНТА (опционально)                                 ║
   ╚══════════════════════════════════════════════════════════════════════════╝ */
app.post('/api/reply', async (req, res) => {
  const { session_id = 'web:local', channel = 'site', text = '', lang = 'ru' } = req.body || {};
  if (!text) return res.status(400).json({ ok: false, error: 'text required' });
  try {
    const out = await smartReply(session_id, channel, text, lang);
    res.json({ ok: true, text: out });
  } catch (e) {
    console.error('/api/reply error', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ╔══════════════════════════════════════════════════════════════════════════╗
   ║ 8) TELEGRAM WEBHOOK                                                      ║
   ╚══════════════════════════════════════════════════════════════════════════╝ */
// GET — для быстрой проверки из браузера
app.get(`/telegram/${WEBHOOK_SECRET}`, (req, res) => {
  res.json({ ok: true, via: 'GET', expected: `/telegram/${WEBHOOK_SECRET}` });
});

// POST — основной канал апдейтов
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
    await tgSend(chatId, answer);

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Telegram webhook error', e);
    // Всегда 200, иначе Telegram засыпет повторами
    res.status(200).json({ ok: true });
  }
});

/* ╔══════════════════════════════════════════════════════════════════════════╗
   ║ 9) ЗАПУСК СЕРВЕРА                                                        ║
   ╚══════════════════════════════════════════════════════════════════════════╝ */
app.listen(PORT, () => {
  console.log(`▶ RenovoGo Bot listening on :${PORT}`);
});
