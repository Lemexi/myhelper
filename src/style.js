// style.js — лёгкая эвристика + запись в sessions.psychotype
import { pool } from './db.js';

export function detectStyle(messages) {
  const txt = messages.join(' ').toLowerCase();
  if (/(сделай|план|дедлайн|конкретно|по пунктам)/.test(txt)) return 'commander';
  if (/(давайте|компромисс|данные|статистика|факты)/.test(txt)) return 'diplomat';
  if (/(важно|семья|люди|забота|понимаю)/.test(txt)) return 'humanist';
  if (/(круто|класс|огонь|я лучший|самый)/.test(txt)) return 'star';
  return null;
}

export async function maybeUpdateStyle(sessionId) {
  const { rows } = await pool.query(`
    SELECT content FROM public.messages
    WHERE session_id=$1 AND role='user'
    ORDER BY created_at DESC LIMIT 5
  `, [sessionId]);
  const style = detectStyle(rows.map(r => r.content));
  if (!style) return null;
  await pool.query(`
    UPDATE public.sessions SET psychotype=$2, updated_at=NOW()
    WHERE id=$1 AND (psychotype IS NULL OR psychotype<>$2)
  `, [sessionId, style]);
  return style;
}
