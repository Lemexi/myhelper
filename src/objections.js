// objections.js — варианты ответов на возражения из KB
import { pool } from './db.js';

export async function getObjectionReply(kind = 'price', variant = 'any') {
  const { rows } = await pool.query(`
    SELECT answer
    FROM public.kb_items
    WHERE category='objections' AND lang='ru' AND question=$1 AND is_active=true
  `, [kind]);
  if (!rows.length) return null;
  if (variant === 'any') return rows[Math.floor(Math.random()*rows.length)].answer;
  const idx = Number(variant) || 0;
  return rows[idx % rows.length].answer;
}
