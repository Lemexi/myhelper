// /src/kb.js
import { pool } from "./db.js";

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

export async function kbEnsureCategory(slug, title = null) {
  const sel = `SELECT id FROM kb_categories WHERE slug=$1 LIMIT 1`;
  const r1 = await pool.query(sel, [slug]);
  if (r1.rows.length) return r1.rows[0].id;

  const ins = `INSERT INTO kb_categories (slug, title) VALUES ($1, $2) RETURNING id`;
  const r2 = await pool.query(ins, [slug, title || slug]);
  return r2.rows[0].id;
}

export async function kbInsertAnswer(slug, lang, answer, isActive = true) {
  const catId = await kbEnsureCategory(slug);
  const q = `
    INSERT INTO kb_items (category_id, lang, answer, is_active)
    VALUES ($1, $2, $3, $4)
    RETURNING id
  `;
  const { rows } = await pool.query(q, [catId, lang, answer, isActive]);
  return rows[0]?.id || null;
}