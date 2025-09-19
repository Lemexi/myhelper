// qna.js — «я бы ответил»: нормализация + похожесть
import { pool } from './db.js';

function normalize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function jaccard(a, b) {
  const as = new Set(a.split(' ').filter(Boolean));
  const bs = new Set(b.split(' ').filter(Boolean));
  const inter = [...as].filter(x => bs.has(x)).length;
  const uni = new Set([...as, ...bs]).size || 1;
  return inter / uni;
}

export async function saveUserQuestion(sessionId, userText) {
  const norm = normalize(userText);
  await pool.query(`
    INSERT INTO public.kb_qna (lang, question_norm_en, question_raw, answer_text, source, session_id, uses, created_at)
    VALUES ('ru', $1, $2, NULL, 'user_question', $3, 0, NOW())
  `, [norm, userText, sessionId]);
}

export async function findAnswerFromKB(userText, threshold = 0.9) {
  const norm = normalize(userText);
  const { rows } = await pool.query(`
    SELECT id, question_norm_en AS norm_q, answer_text
    FROM public.kb_qna
    WHERE answer_text IS NOT NULL AND answer_text <> ''
    ORDER BY created_at DESC
    LIMIT 200
  `);
  const candidates = rows
    .map(r => ({ ...r, sim: jaccard(norm, normalize(r.norm_q)) }))
    .filter(r => r.sim >= threshold);

  if (!candidates.length) return null;
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  await pool.query(`UPDATE public.kb_qna SET uses = COALESCE(uses,0)+1 WHERE id=$1`, [pick.id]);
  return pick.answer_text;
}
