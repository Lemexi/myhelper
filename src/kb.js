// /src/kb.js
import { pool } from "./db.js";

// получить ответ по категории/языку
export async function kbFind(categorySlug, lang) {
  const q = `
    SELECT ki.id, ki.answer
    FROM kb_items ki
    JOIN kb_categories kc ON kc.id = ki.category_id
    WHERE kc.slug = $1 AND ki.lang = $2 AND ki.is_active = TRUE
    ORDER BY ki.id DESC
    LIMIT 1
  `;
  const { rows } = await pool.query(q, [categorySlug, lang]);
  return rows[0] || null;
}

// обеспечить категорию (создать, если нет)
export async function ensureCategory(slug) {
  const sel = `SELECT id FROM kb_categories WHERE slug=$1 LIMIT 1`;
  const r = await pool.query(sel, [slug]);
  if (r.rows.length) return r.rows[0].id;
  const ins = `INSERT INTO kb_categories (slug, title) VALUES ($1,$1) RETURNING id`;
  const insR = await pool.query(ins, [slug]);
  return insR.rows[0].id;
}

// записать ответ (обучение)
export async function kbInsertAnswer(categorySlug, lang, answer, isActive = true) {
  const categoryId = await ensureCategory(categorySlug || "general");
  const ins = `
    INSERT INTO kb_items (category_id, lang, answer, is_active)
    VALUES ($1,$2,$3,$4)
    RETURNING id
  `;
  try {
    const { rows } = await pool.query(ins, [categoryId, lang || "ru", answer, !!isActive]);
    console.log("[KB] saved item", { categorySlug, lang, id: rows[0]?.id });
    return rows[0]?.id || null;
  } catch (e) {
    console.error("[KB] insert error:", e.message);
    throw e;
  }
}