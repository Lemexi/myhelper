// /src/db.js
import pg from "pg";
const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
});

// ── sessions ─────────────────────────────────────────────────────────────────
export async function upsertSession(sessionKey, channel) {
  const sel = "SELECT id FROM sessions WHERE session_key=$1 LIMIT 1";
  const { rows } = await pool.query(sel, [sessionKey]);
  if (rows.length) return rows[0].id;
  const ins = "INSERT INTO sessions (session_key, channel) VALUES ($1,$2) RETURNING id";
  const r = await pool.query(ins, [sessionKey, channel]);
  return r.rows[0].id;
}
export async function getSession(id) {
  const { rows } = await pool.query("SELECT * FROM sessions WHERE id=$1 LIMIT 1", [id]);
  return rows[0] || null;
}
export async function updateContact(sessionId, { name=null, phone=null, locale=null } = {}) {
  const parts=[]; const vals=[]; let i=1;
  if (name)  { parts.push(`user_name=$${i++}`);  vals.push(name); }
  if (phone) { parts.push(`user_phone=$${i++}`); vals.push(phone); }
  if (locale){ parts.push(`locale=$${i++}`);    vals.push(locale); }
  if (!parts.length) return;
  vals.push(sessionId);
  await pool.query(`UPDATE sessions SET ${parts.join(", ")}, updated_at=NOW() WHERE id=$${i}`, vals);
}

// ── messages / summaries / reply_audit ───────────────────────────────────────
export async function saveMessage(sessionId, role, content, meta=null, lang=null, translated_to=null, translated_content=null, category=null) {
  try {
    const q = `
      INSERT INTO messages (session_id, role, content, meta_json, lang, translated_to, translated_content, category)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
    `;
    const { rows } = await pool.query(q, [
      sessionId, role, content,
      meta ? JSON.stringify(meta) : null,
      lang, translated_to, translated_content, category
    ]);
    return rows[0]?.id || null;
  } catch (e) {
    console.error("[DB] saveMessage error:", e.message);
    return null;
  }
}

export async function loadRecentMessages(sessionId, limit=24) {
  const q = "SELECT role, content FROM messages WHERE session_id=$1 ORDER BY id DESC LIMIT $2";
  const { rows } = await pool.query(q, [sessionId, limit]);
  return rows.reverse().map(r => ({ role: r.role, content: r.content }));
}
export async function loadLatestSummary(sessionId) {
  const q = "SELECT content FROM summaries WHERE session_id=$1 ORDER BY id DESC LIMIT 1";
  const { rows } = await pool.query(q, [sessionId]);
  return rows.length ? rows[0].content : null;
}
export async function logReply(sessionId, strategy, category, kbItemId, messageId=null, notes=null) {
  // страховка под CHECK CONSTRAINT
  const allowed = new Set(["kb_hit","kb_translated","fallback_llm","cmd"]);
  const safe = allowed.has(strategy) ? strategy : "cmd";
  const q = `
    INSERT INTO reply_audit (session_id, strategy, category, kb_item_id, message_id, notes)
    VALUES ($1,$2,$3,$4,$5,$6)
  `;
  await pool.query(q, [sessionId, safe, category, kbItemId, messageId, notes]);
}
export async function getLastAuditCategory(sessionId){
  const { rows } = await pool.query(
    "SELECT category FROM reply_audit WHERE session_id=$1 AND category IS NOT NULL ORDER BY id DESC LIMIT 1",
    [sessionId]
  );
  return rows[0]?.category || null;
}

// Последняя пара: пользовательское сообщение → ответ ассистента
export async function getLastUserBotPair(sessionId){
  const q=`
    SELECT a.id as bot_id, a.content as bot_en, a.category as bot_cat, a.created_at as bot_ts,
           u.id as user_id, u.content as user_en, u.created_at as user_ts
    FROM messages a
    JOIN messages u ON u.session_id=a.session_id AND u.id = (
      SELECT id FROM messages
      WHERE session_id=a.session_id AND role='user' AND id < a.id
      ORDER BY id DESC LIMIT 1
    )
    WHERE a.session_id=$1 AND a.role='assistant' AND COALESCE(a.meta_json->>'strategy','') <> 'cmd_teach'
    ORDER BY a.id DESC LIMIT 1
  `;
  const { rows } = await pool.query(q,[sessionId]);
  return rows[0] || null;
}

// ── corrections (обучения) ──────────────────────────────────────────────────
async function ensureCorrectionsTable(){
  const sql = `
  CREATE TABLE IF NOT EXISTS corrections (
    id              bigserial PRIMARY KEY,
    session_id      bigint NOT NULL,
    bot_message_id  bigint NOT NULL,
    category        text,
    trigger_user_en text,           -- ← сообщение пользователя, на которое отвечал бот
    prev_answer_en  text NOT NULL,  -- ← исходный ответ бота (EN)
    taught_en       text NOT NULL,  -- ← как надо отвечать (EN)
    taught_local    text,           -- ← как писал менеджер (локальный язык)
    taught_lang     text,           -- ← язык taught_local
    created_at      timestamptz DEFAULT now()
  );
  `;
  await pool.query(sql);
}
export async function insertCorrection({session_id, bot_message_id, category, trigger_user_en, prev_answer_en, taught_en, taught_local, taught_lang}){
  await ensureCorrectionsTable();
  const { rows } = await pool.query(`
    INSERT INTO corrections (session_id, bot_message_id, category, trigger_user_en, prev_answer_en, taught_en, taught_local, taught_lang)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING id
  `,[session_id, bot_message_id, category||null, trigger_user_en||null, prev_answer_en, taught_en, taught_local||null, taught_lang||null]);
  return rows[0]?.id || null;
}
export async function findCorrectionsByCategory(category, limit=30){
  await ensureCorrectionsTable();
  const { rows } = await pool.query(`
    SELECT id, category, trigger_user_en, prev_answer_en, taught_en, taught_local, taught_lang
    FROM corrections
    WHERE ($1::text IS NULL AND category IS NULL) OR category=$1
    ORDER BY id DESC
    LIMIT $2
  `,[category||null, limit]);
  return rows;
}