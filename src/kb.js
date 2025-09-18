import { pool } from "./db.js";

/* ───────── Нормализация и похожесть (только для «question») ───────── */
function stripEmojis(s="") {
  return (s || "").replace(/[\p{Extended_Pictographic}\uFE0F]/gu, "");
}
function qnorm(s="") {
  return stripEmojis(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function trigrams(s, n=3) {
  const t = `  ${qnorm(s)}  `;
  const set = new Set();
  for (let i=0; i<=t.length-n; i++) set.add(t.slice(i, i+n));
  return set;
}
function jaccard3(a, b) {
  const A = trigrams(a), B = trigrams(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const uni = A.size + B.size - inter;
  if (uni === 0) return 0;
  return inter / uni;
}

/**
 * Найти ответ из KB по категории/языку и (опционально) «вопросу-пользователя».
 * Возвращает только если сходство вопроса ≥ 0.9. Иначе — null.
 */
export async function kbFind(categorySlug, lang, question = null) {
  const q = `
    SELECT ki.id, ki.answer, ki.question
    FROM kb_items ki
    JOIN kb_categories kc ON kc.id = ki.category_id
    WHERE kc.slug = $1
      AND ki.lang = $2
      AND ki.is_active = TRUE
  `;
  const { rows } = await pool.query(q, [categorySlug, lang]);
  if (!rows.length) return null;

  if (question && question.trim()) {
    const qn = qnorm(question);
    // выбираем лучшую запись по Jaccard(3-gram)
    let best = null, bestScore = -1;
    for (const r of rows) {
      if (!r.question) continue;
      const score = jaccard3(qn, r.question);
      if (score > bestScore) { best = r; bestScore = score; }
    }
    if (best && bestScore >= 0.9) return best;
    return null; // нет достаточно близкого — KB не срабатывает
  }

  return null; // если вопрос не передали — не используем KB по умолчанию
}

/* Категории */
export async function kbEnsureCategory(slug, title = null) {
  const sel = `SELECT id FROM kb_categories WHERE slug=$1 LIMIT 1`;
  const r1 = await pool.query(sel, [slug]);
  if (r1.rows.length) return r1.rows[0].id;

  const ins = `INSERT INTO kb_categories (slug, title) VALUES ($1, $2) RETURNING id`;
  const r2 = await pool.query(ins, [slug, title || slug]);
  return r2.rows[0].id;
}

/**
 * Вставить обучающий ответ. В question кладём НОРМАЛИЗОВАННУЮ прошлую реплику пользователя.
 */
export async function kbInsertAnswer(slug, lang, answer, isActive = true, question = null) {
  const catId = await kbEnsureCategory(slug);
  const q = `
    INSERT INTO kb_items (category_id, lang, answer, is_active, question)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id
  `;
  const normQ = question ? qnorm(question) : null;
  const { rows } = await pool.query(q, [catId, lang, answer, isActive, normQ]);
  return rows[0]?.id || null;
}

export async function kbInsertTaughtAnswer(slug, lang, answer, question = null, isActive = true) {
  return kbInsertAnswer(slug, lang, answer, isActive, question);
}

export { qnorm }; // пригодится в reply.js