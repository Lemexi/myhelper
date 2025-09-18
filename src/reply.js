// src/reply.js
import { pool } from './db.js';

// ───── helpers ─────
async function q(sql, params = []) {
  const c = await pool.connect();
  try { return await c.query(sql, params); }
  finally { c.release(); }
}

function tgNum(idOrKey) {
  // "tg:12345" -> 12345
  const s = String(idOrKey);
  return Number(s.startsWith('tg:') ? s.slice(3) : s);
}

async function logReply({ chatId, incoming, outgoing, strategy }) {
  try {
    await q(
      `INSERT INTO reply_audit(chat_id, incoming_text, outgoing_text, strategy)
       VALUES ($1,$2,$3,$4)`,
      [ tgNum(chatId), incoming, outgoing, strategy ]
    );
  } catch (e) { console.error('logReply', e.message); }
}

async function getLastBotReply(chatId) {
  try {
    const r = await q(
      `SELECT outgoing_text FROM reply_audit
       WHERE chat_id = $1 AND outgoing_text IS NOT NULL
       ORDER BY id DESC LIMIT 1`,
      [ tgNum(chatId) ]
    );
    return r.rows[0]?.outgoing_text || '';
  } catch {
    return '';
  }
}

// ───── одноразовый флаг (в рамках одной операции) ─────
async function withFlag(chatId, flag, fn) {
  // транзакция гарантирует постановку и снятие
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      `INSERT INTO runtime_flags(chat_id, flag) 
       VALUES ($1,$2)
       ON CONFLICT (chat_id) DO UPDATE SET flag=EXCLUDED.flag, created_at=NOW()`,
      [ String(chatId), flag ]
    );

    const res = await fn(c);

    await c.query(`DELETE FROM runtime_flags WHERE chat_id=$1`, [ String(chatId) ]);
    await c.query('COMMIT');
    return res;
  } catch (e) {
    try { await c.query(`DELETE FROM runtime_flags WHERE chat_id=$1`, [ String(chatId) ]); } catch {}
    try { await c.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    c.release();
  }
}

// ───── /teach ─────
// /teach <текст коррекции>
// Коррекция относится к ПОСЛЕДНЕМУ ответу бота
export async function oneShotTeach({ chatId, userId, payload, lang='ru' }) {
  const correction = (payload || '').trim();
  if (!correction) return 'Нужен текст после «Отвечал бы…» / /teach.';

  return await withFlag(chatId, 'teach', async () => {
    const lastBot = await getLastBotReply(chatId);
    await q(
      `INSERT INTO corrections(bot_reply, correction, trigger_user, trigger_user_lang)
       VALUES ($1,$2,$3,$4)`,
      [ lastBot, correction, String(chatId), lang ]
    );
    await logReply({ chatId, incoming: `/teach ${correction}`, outgoing: '✅ В базу добавлено.', strategy: 'teach' });
    return '✅ В базу добавлено.';
  });
}

// ───── /translate ─────
// Форматы: /translate en: текст  |  /translate en текст
export async function oneShotTranslate({ chatId, userId, text, defaultFrom='ru' }) {
  const m = text.match(/^\/translate\s+([a-z]{2})\s*[:\s]+([\s\S]+)$/i);
  if (!m) return 'Пример: /translate en: Привет!';

  const target = m[1].toLowerCase();
  const payload = m[2].trim();

  return await withFlag(chatId, 'translate', async () => {
    // TODO: замените на реальный переводчик
    const translated = payload; // plug: вернуть payload как есть
    await logReply({ chatId, incoming: text, outgoing: translated, strategy: 'translate' });
    return translated;
  });
}

// ───── KB-first ответ ─────
export async function smartReply(session_id, channel, userText, lang='ru') {
  const chatId = session_id;

  // 1) пытаемся отдать коррекцию (если ранее мы правили похожий "черновик" ответа)
  // Схема: сначала считаем черновик (ниже veryBaseDraft), затем ищем похожий bot_reply в corrections.
  const draft = veryBaseDraft(userText); // можно заменить на Groq/твои правила

  const corr = await q(
    `SELECT correction
       FROM corrections
      WHERE bot_reply % $1           -- триграмм-похожесть
      ORDER BY similarity(bot_reply, $1) DESC
      LIMIT 1`,
    [ draft ]
  );
  if (corr.rows[0]?.correction) {
    const out = corr.rows[0].correction;
    await logReply({ chatId, incoming: userText, outgoing: out, strategy: 'kb-correction' });
    return out;
  }

  // 2) сюда можно добавить поиск по kb_items (FAQ/скрипты)
  const kb = await tryKB(userText);
  if (kb) {
    await logReply({ chatId, incoming: userText, outgoing: kb, strategy: 'kb-item' });
    return kb;
  }

  // 3) fallback: генерируем (или используем твои правила/LLM)
  const out = veryBaseDraft(userText);
  await logReply({ chatId, incoming: userText, outgoing: out, strategy: 'fallback' });
  return out;
}

// Заглушка «мозг» — замени на твой пайплайн (Groq + категории и т.п.)
function veryBaseDraft(t) {
  if (/привет|здрав/i.test(t)) return 'Здравствуйте! Чем могу помочь?';
  if (/как дела/i.test(t)) return 'Спасибо, всё отлично. Готов работать.';
  return `Понял: «${t}». Уточните, пожалуйста.`;
}

// Поиск в kb_items (если используешь)
async function tryKB(userText) {
  // пример: точные триггеры в slug или почти точные совпадения вопроса
  const r = await q(
    `SELECT answer
       FROM kb_items
      WHERE active = TRUE
        AND (question ILIKE '%'||$1||'%' OR slug ILIKE '%'||$1||'%')
      ORDER BY id DESC
      LIMIT 1`,
    [ userText.slice(0, 80) ]
  );
  return r.rows[0]?.answer || null;
}