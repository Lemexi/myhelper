// /src/qna.js
// Логирование вопросов пользователя и поиск готовых ответов из KB
// Требования к БД (миграция):
// - kb_qna.answer_text допускает NULL
// - CHECK: source='user_question' => answer_text IS NULL
// - Индекс (partial): idx_kb_qna_norm_with_answer WHERE answer_text IS NOT NULL
// - Уникальность пользовательских вопросов: (session_id, question_norm_en) WHERE source='user_question'

import { pool } from './db.js';

/* ───────────────── helpers ───────────────── */

function normalize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function jaccard(a, b) {
  const A = new Set(a.split(' ').filter(Boolean));
  const B = new Set(b.split(' ').filter(Boolean));
  const inter = [...A].filter(x => B.has(x)).length;
  const uni = new Set([...A, ...B]).size || 1;
  return inter / uni;
}

/* ───────────────── write: save user question ───────────────── */

/**
 * Сохраняет нормализованный вопрос пользователя в kb_qna
 * без ответа (answer_text = NULL). Дубликаты подряд/по уникальному
 * индексу не плодим.
 */
export async function saveUserQuestion(sessionId, userText) {
  const norm = normalize(userText);

  // если последний такой же — пропускаем
  const { rows: prev } = await pool.query(
    `SELECT question_norm_en
     FROM public.kb_qna
     WHERE session_id=$1 AND source='user_question'
     ORDER BY created_at DESC
     LIMIT 1`,
    [sessionId]
  );
  if (prev[0]?.question_norm_en === norm) return;

  // возможен конфликт по уникальному индексу — молча игнорируем
  await pool.query(
    `INSERT INTO public.kb_qna
       (lang, question_norm_en, question_raw, answer_text, source, session_id, uses, created_at)
     VALUES
       ('ru', $1, $2, NULL, 'user_question', $3, 0, NOW())
     ON CONFLICT (session_id, question_norm_en)
       WHERE source='user_question'
     DO NOTHING`,
    [norm, userText, sessionId]
  );
}

/* ───────────────── read: find KB answer by similarity ───────────────── */

/**
 * Ищет готовый ответ в kb_qna по похожести нормализованного вопроса.
 * Берём только записи, где answer_text IS NOT NULL.
 * @param {string} userText     — исходный текст пользователя (любой язык)
 * @param {number} threshold    — порог схожести (0..1), по умолчанию 0.9
 * @param {number} searchLimit  — сколько последних кандидатов смотреть
 * @returns {string|null}       — текст ответа или null
 */
export async function findAnswerFromKB(userText, threshold = 0.9, searchLimit = 300) {
  const norm = normalize(userText);

  // Берём только карточки с ответами (быстрый индекс по question_norm_en)
  const { rows } = await pool.query(
    `SELECT id, question_norm_en AS norm_q, answer_text
     FROM public.kb_qna
     WHERE answer_text IS NOT NULL
     ORDER BY created_at DESC
     LIMIT $1`,
    [searchLimit]
  );

  // Считаем похожесть, фильтруем по порогу
  const candidates = rows
    .map(r => ({ ...r, sim: jaccard(norm, normalize(r.norm_q)) }))
    .filter(r => r.sim >= threshold);

  if (!candidates.length) return null;

  // Если несколько — берём случайный, чтобы не зацикливать одинаковый
  const pick = candidates[Math.floor(Math.random() * candidates.length)];

  // Инкрементируем uses
  await pool.query(
    `UPDATE public.kb_qna SET uses = COALESCE(uses,0)+1 WHERE id=$1`,
    [pick.id]
  );

  return pick.answer_text;
}

/* ───────────────── optional: admin add/update answer ───────────────── */

/**
 * Добавляет/обновляет готовую карточку ответа в kb_qna.
 * Удобно для админки «Я бы ответил».
 */
export async function upsertKBAnswer({ lang = 'ru', question, answer, source = 'manual', kbId = null }) {
  const norm = normalize(question);

  if (kbId) {
    await pool.query(
      `UPDATE public.kb_qna
       SET lang=$2, question_norm_en=$3, question_raw=$4, answer_text=$5, source=$6, updated_at=NOW()
       WHERE id=$1`,
      [kbId, lang, norm, question, answer, source]
    );
    return kbId;
  }

  const { rows } = await pool.query(
    `INSERT INTO public.kb_qna
       (lang, question_norm_en, question_raw, answer_text, source, uses, created_at)
     VALUES
       ($1, $2, $3, $4, $5, 0, NOW())
     RETURNING id`,
    [lang, norm, question, answer, source]
  );
  return rows[0].id;
}