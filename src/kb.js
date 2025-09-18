// /src/kb.js
import { pool } from "./db.js";

/**
 * Найти ответ из KB.
 * - Сначала приоритет тем записям, где question матчится под переданный question (ILIKE).
 * - Затем все активные по категории/языку.
 * - В обоих случаях выбираем СЛУЧАЙНО (ORDER BY random()).
 *
 * @param {string} categorySlug  - slug категории (например "general", "expensive")
 * @param {string} lang          - язык ответа ("ru"/"en"/...)
 * @param {string|null} question - исходный вопрос/реплика, к которой хотим привязать ответ
 * @returns {{id:number, answer:string, question:string|null}|null}
 */
export async function kbFind(categorySlug, lang, question = null) {
  // 1) сначала пытаемся найти по совпадению вопроса
  if (question && question.trim().length > 0) {
    const withQuestionSql = `
      SELECT ki.id, ki.answer, ki.question
      FROM kb_items ki
      JOIN kb_categories kc ON kc.id = ki.category_id
      WHERE kc.slug = $1
        AND ki.lang = $2
        AND ki.is_active = TRUE
        AND ki.question IS NOT NULL
        AND ki.question ILIKE '%' || $3 || '%'
      ORDER BY random()
      LIMIT 1
    `;
    const r1 = await pool.query(withQuestionSql, [categorySlug, lang, question]);
    if (r1.rows.length) return r1.rows[0];
  }

  // 2) иначе — любой активный по категории/языку, случайно
  const anySql = `
    SELECT ki.id, ki.answer, ki.question
    FROM kb_items ki
    JOIN kb_categories kc ON kc.id = ki.category_id
    WHERE kc.slug = $1
      AND ki.lang = $2
      AND ki.is_active = TRUE
    ORDER BY random()
    LIMIT 1
  `;
  const r2 = await pool.query(anySql, [categorySlug, lang]);
  return r2.rows[0] || null;
}

/**
 * Убедиться, что категория существует, и вернуть её id.
 */
export async function kbEnsureCategory(slug, title = null) {
  const sel = `SELECT id FROM kb_categories WHERE slug=$1 LIMIT 1`;
  const r1 = await pool.query(sel, [slug]);
  if (r1.rows.length) return r1.rows[0].id;

  const ins = `INSERT INTO kb_categories (slug, title) VALUES ($1, $2) RETURNING id`;
  const r2 = await pool.query(ins, [slug, title || slug]);
  return r2.rows[0].id;
}

/**
 * Вставить (или «научить») ответ в KB.
 * Теперь поддерживает опциональное поле question.
 *
 * @param {string} slug
 * @param {string} lang
 * @param {string} answer
 * @param {boolean} isActive
 * @param {string|null} question
 * @returns {number|null} id созданной записи
 */
export async function kbInsertAnswer(slug, lang, answer, isActive = true, question = null) {
  const catId = await kbEnsureCategory(slug);
  const q = `
    INSERT INTO kb_items (category_id, lang, answer, is_active, question)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id
  `;
  const { rows } = await pool.query(q, [catId, lang, answer, isActive, question]);
  return rows[0]?.id || null;
}

/**
 * Синоним для явной «обучающей» вставки.
 * Удобно вызывать из обработчика "Я бы ответил".
 */
export async function kbInsertTaughtAnswer(slug, lang, answer, question = null, isActive = true) {
  return kbInsertAnswer(slug, lang, answer, isActive, question);
}