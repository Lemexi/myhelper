// /src/kb.js
import { pool } from './db.js';

export async function kbFind(categorySlug, lang) {
  const q = `
    SELECT ki.id, ki.answer
    FROM kb_items ki
    JOIN kb_categories kc ON kc.id = ki.category_id
    WHERE kc.slug = $1 AND ki.lang = $2 AND ki.is_active = TRUE
    ORDER BY ki.id ASC
    LIMIT 1
  `;
  const { rows } = await pool.query(q, [categorySlug, lang]);
  return rows[0] || null;
}
