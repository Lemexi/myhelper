// study.js
import { db } from './db.js';

export async function addJob({ title, country, city, salary, hours, notes }) {
  const q = `
    INSERT INTO public.kb_items (category, lang, question, answer, is_active, created_at)
    VALUES ('jobs','ru',$1,$2,true,NOW())
    RETURNING id
  `;
  const text = JSON.stringify({ country, city, salary, hours, notes });
  const { rows } = await db.query(q, [title, text]);
  return rows[0].id;
}

export async function listJobs(limit=20) {
  const { rows } = await db.query(`
    SELECT id, question AS title, answer
    FROM public.kb_items
    WHERE category='jobs' AND is_active=true
    ORDER BY created_at DESC LIMIT $1
  `, [limit]);
  return rows;
}
