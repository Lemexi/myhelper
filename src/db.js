// /src/db.js
import pg from "pg";
const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30_000,
});

/* ───────────── sessions ───────────── */

export async function upsertSession(sessionKey, channel) {
  const sel = `SELECT id FROM sessions WHERE session_key=$1 LIMIT 1`;
  const { rows } = await pool.query(sel, [sessionKey]);
  if (rows.length) return rows[0].id;

  const ins = `
    INSERT INTO sessions (session_key, channel)
    VALUES ($1,$2)
    RETURNING id
  `;
  const insRes = await pool.query(ins, [sessionKey, channel]);
  return insRes.rows[0].id;
}

export async function updateContact(
  sessionId,
  { name = null, phone = null, locale = null } = {}
) {
  const parts = [];
  const vals = [];
  let i = 1;

  if (name)  { parts.push(`user_name=$${i++}`);  vals.push(name); }
  if (phone) { parts.push(`user_phone=$${i++}`); vals.push(phone); }
  if (locale){ parts.push(`locale=$${i++}`);     vals.push(locale); }

  if (!parts.length) return;
  vals.push(sessionId);

  const sql = `UPDATE sessions SET ${parts.join(", ")}, updated_at=NOW() WHERE id=$${i}`;
  await pool.query(sql, vals);
}

export async function getSession(sessionId) {
  const q = `
    SELECT id, user_name, user_phone, locale, orchestrator AS meta
    FROM sessions
    WHERE id=$1
  `;
  const { rows } = await pool.query(q, [sessionId]);
  // возвращаем поле meta как объект (или пустой)
  const row = rows[0] || null;
  if (!row) return null;
  return {
    id: row.id,
    user_name: row.user_name,
    user_phone: row.user_phone,
    locale: row.locale,
    // orchestrator JSONB может лежать в meta / orchestrator
    meta_json: row.meta || {}
  };
}

/** Патч jsonb-поля orchestrator: глубокое объединение верхнего уровня */
export async function patchSessionMeta(sessionId, patchObj = {}) {
  if (!patchObj || typeof patchObj !== "object") return;

  const q = `
    UPDATE sessions
    SET orchestrator = COALESCE(orchestrator, '{}'::jsonb) || $2::jsonb,
        updated_at = NOW()
    WHERE id = $1
  `;
  await pool.query(q, [sessionId, JSON.stringify(patchObj)]);
}

/* ───────────── messages ───────────── */

export async function saveMessage(
  sessionId,
  role,
  content,
  meta = null,            // объект → meta_json (jsonb)
  lang = null,           // язык исходного content
  translated_to = null,  // язык локализации, если есть
  translated_content = null, // локализованный текст (для отображения пользователю)
  category = null
) {
  const q = `
    INSERT INTO messages
      (session_id, role, content, meta_json, lang, translated_to, translated_content, category)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING id
  `;
  const { rows } = await pool.query(q, [
    sessionId,
    role,
    content,
    meta ? JSON.stringify(meta) : null,
    lang,
    translated_to,
    translated_content,
    category
  ]);
  return rows[0]?.id || null;
}

export async function loadRecentMessages(sessionId, limit = 24) {
  const q = `
    SELECT id, role, content, translated_content, meta_json, created_at
    FROM messages
    WHERE session_id=$1
    ORDER BY id DESC
    LIMIT $2
  `;
  const { rows } = await pool.query(q, [sessionId, limit]);

  // вернуть в хронологическом порядке (старые → новые)
  return rows.reverse().map(r => ({
    id: r.id,
    role: r.role,
    content: r.content,
    translated_content: r.translated_content,
    meta_json: r.meta_json || {},
    created_at: r.created_at
  }));
}

/** Последняя предыдущая реплика пользователя (до текущей команды) */
export async function getPreviousUserUtterance(sessionId) {
  const q = `
    SELECT id, content, translated_content
    FROM messages
    WHERE session_id=$1 AND role='user'
    ORDER BY id DESC
    LIMIT 2
  `;
  const { rows } = await pool.query(q, [sessionId]);
  if (rows.length < 2) return { id: null, text: null };
  const prev = rows[1];
  const text = (prev.translated_content && prev.translated_content.trim())
    ? prev.translated_content
    : prev.content;
  return { id: prev.id, text };
}

/* ───────────── summaries ───────────── */

export async function loadLatestSummary(sessionId) {
  const q = `
    SELECT content
    FROM summaries
    WHERE session_id=$1
    ORDER BY id DESC
    LIMIT 1
  `;
  const { rows } = await pool.query(q, [sessionId]);
  return rows.length ? rows[0].content : null;
}

export async function saveSummary(sessionId, turnNo, content) {
  const q = `
    INSERT INTO summaries (session_id, turn_no, content)
    VALUES ($1,$2,$3)
    ON CONFLICT (session_id, turn_no)
    DO UPDATE SET content=EXCLUDED.content
  `;
  await pool.query(q, [sessionId, turnNo, content]);
}

/* ───────────── audit ───────────── */

export async function logReply(
  sessionId,
  strategy,
  category,
  kbItemId,
  messageId = null,
  notes = null
) {
  const q = `
    INSERT INTO reply_audit
      (session_id, strategy, category, kb_item_id, message_id, notes)
    VALUES ($1,$2,$3,$4,$5,$6)
  `;
  await pool.query(q, [sessionId, strategy, category, kbItemId, messageId, notes]);
}

export async function getLastAuditCategory(sessionId) {
  const q = `
    SELECT category
    FROM reply_audit
    WHERE session_id=$1
    ORDER BY id DESC
    LIMIT 1
  `;
  const { rows } = await pool.query(q, [sessionId]);
  return rows[0]?.category || null;
}