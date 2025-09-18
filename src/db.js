// /src/db.js
import pg from "pg";
const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
});

// ─────────────────────────────────────────────────────────────────────────────
// Sessions
// ─────────────────────────────────────────────────────────────────────────────
export async function upsertSession(sessionKey, channel) {
  const sel = 'SELECT id FROM sessions WHERE session_key=$1 LIMIT 1';
  const { rows } = await pool.query(sel, [sessionKey]);
  if (rows.length) return rows[0].id;
  const ins = 'INSERT INTO sessions (session_key, channel) VALUES ($1,$2) RETURNING id';
  const insRes = await pool.query(ins, [sessionKey, channel]);
  return insRes.rows[0].id;
}

export async function getSession(id) {
  const { rows } = await pool.query('SELECT * FROM sessions WHERE id=$1 LIMIT 1', [id]);
  return rows[0] || null;
}

export async function updateContact(sessionId, { name=null, phone=null, locale=null } = {}) {
  const parts = []; const vals = []; let i = 1;
  if (name)  { parts.push(`user_name=$${i++}`);  vals.push(name); }
  if (phone) { parts.push(`user_phone=$${i++}`); vals.push(phone); }
  if (locale){ parts.push(`locale=$${i++}`);    vals.push(locale); }
  if (!parts.length) return;
  vals.push(sessionId);
  const sql = `UPDATE sessions SET ${parts.join(', ')}, updated_at=NOW() WHERE id=$${i}`;
  await pool.query(sql, vals);
}

// ─────────────────────────────────────────────────────────────────────────────
// Messages
// ─────────────────────────────────────────────────────────────────────────────
export async function saveMessage(
  sessionId,
  role,
  content,
  meta=null,
  lang=null,
  translated_to=null,
  translated_content=null,
  category=null
) {
  try {
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
  } catch (e) {
    console.error("[DB] saveMessage error:", e.message, { sessionId, role, category });
    return null;
  }
}

export async function loadRecentMessages(sessionId, limit=24) {
  const q = 'SELECT role, content FROM messages WHERE session_id=$1 ORDER BY id DESC LIMIT $2';
  const { rows } = await pool.query(q, [sessionId, limit]);
  return rows.reverse().map(r => ({ role: r.role, content: r.content }));
}

export async function loadLatestSummary(sessionId) {
  const q = 'SELECT content FROM summaries WHERE session_id=$1 ORDER BY id DESC LIMIT 1';
  const { rows } = await pool.query(q, [sessionId]);
  return rows.length ? rows[0].content : null;
}

export async function logReply(sessionId, strategy, category, kbItemId, messageId=null, notes=null) {
  // В некоторых БД есть CHECK на strategy — используем только «безопасные» значения.
  const allowed = new Set(["kb_hit","kb_translated","fallback_llm","cmd"]);
  const safeStrategy = allowed.has(strategy) ? strategy : "cmd";
  const q = `
    INSERT INTO reply_audit (session_id, strategy, category, kb_item_id, message_id, notes)
    VALUES ($1,$2,$3,$4,$5,$6)
  `;
  await pool.query(q, [sessionId, safeStrategy, category, kbItemId, messageId, notes]);
}

export async function getLastAuditCategory(sessionId) {
  const q = `SELECT category FROM reply_audit WHERE session_id=$1 AND category IS NOT NULL ORDER BY id DESC LIMIT 1`;
  const { rows } = await pool.query(q, [sessionId]);
  return rows[0]?.category || null;
}

// Последнее нормальное сообщение бота (не teach-подтверждение)
export async function getLastAssistantMessage(sessionId) {
  const q = `
    SELECT id, content, translated_content, category, meta_json, created_at
    FROM messages
    WHERE session_id=$1
      AND role='assistant'
      AND COALESCE(meta_json->>'strategy','') <> 'cmd_teach'
    ORDER BY id DESC
    LIMIT 1
  `;
  const { rows } = await pool.query(q, [sessionId]);
  return rows[0] || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Corrections (обучение «перепиши мой последний ответ»)
// ─────────────────────────────────────────────────────────────────────────────
async function ensureCorrectionsTable() {
  const sql = `
  CREATE TABLE IF NOT EXISTS corrections (
    id bigserial PRIMARY KEY,
    session_id bigint NOT NULL,
    bot_message_id bigint NOT NULL,
    category text,
    prev_answer_en text NOT NULL,
    taught_en text NOT NULL,
    taught_local text,
    taught_lang text,
    created_at timestamptz DEFAULT now()
  );
  `;
  await pool.query(sql);
}

export async function insertCorrection({
  session_id, bot_message_id, category,
  prev_answer_en, taught_en, taught_local, taught_lang
}) {
  await ensureCorrectionsTable();
  const q = `
    INSERT INTO corrections (session_id, bot_message_id, category, prev_answer_en, taught_en, taught_local, taught_lang)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    RETURNING id
  `;
  const { rows } = await pool.query(q, [
    session_id, bot_message_id, category || null,
    prev_answer_en, taught_en, taught_local || null, taught_lang || null
  ]);
  return rows[0]?.id || null;
}

export async function findCorrectionsByCategory(category, limit=20) {
  await ensureCorrectionsTable();
  const q = `
    SELECT id, category, prev_answer_en, taught_en, taught_local, taught_lang
    FROM corrections
    WHERE ($1::text IS NULL AND category IS NULL) OR category=$1
    ORDER BY id DESC
    LIMIT $2
  `;
  const { rows } = await pool.query(q, [category || null, limit]);
  return rows;
}