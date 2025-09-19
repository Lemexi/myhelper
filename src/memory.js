// memory.js
import { db } from './db.js';

// базовые факты, которые мы держим в sessions
export async function getSessionProfile(sessionId) {
  const { rows } = await db.query(`
    SELECT id, user_name, user_surname, user_phone, user_email,
           role_guess, intent_main, country_interest, candidates_planned,
           psychotype, style_notes, stage, trust_score
    FROM public.sessions WHERE id = $1
  `, [sessionId]);
  return rows[0] || null;
}

export function extractNameFrom(text) {
  if (!text) return null;
  // очень простой извлекатель «меня зовут … / меня звать … / я …»
  const m1 = text.match(/меня\s+зовут\s+([А-ЯЁA-Z][а-яёa-z]+)(?:\s+([А-ЯЁA-Z][а-яёa-z]+))?/i);
  if (m1) return m1[1];
  const m2 = text.match(/^я\s+([А-ЯЁA-Z][а-яёa-z]+)/i);
  if (m2) return m2[1];
  return null;
}

export async function ensureName(sessionId, userMessage, tgMeta) {
  const { rows } = await db.query('SELECT user_name FROM public.sessions WHERE id=$1', [sessionId]);
  const current = rows[0]?.user_name;
  if (current) return current;

  const fromText = extractNameFrom(userMessage);
  const fromTG   = tgMeta?.from?.first_name || tgMeta?.message?.from?.first_name;
  const finalName = fromText || fromTG || null;

  if (finalName) {
    await db.query('UPDATE public.sessions SET user_name=$1, updated_at=NOW() WHERE id=$2', [finalName, sessionId]);
    return finalName;
  }
  return null;
}

// апдейт фактов, безопасный (не затираем уже известное)
export async function upsertFacts(sessionId, facts = {}) {
  const q = `
    UPDATE public.sessions SET
      role_guess        = COALESCE($2, role_guess),
      intent_main       = COALESCE($3, intent_main),
      country_interest  = COALESCE($4, country_interest),
      candidates_planned= COALESCE($5, candidates_planned),
      stage             = COALESCE($6, stage),
      updated_at        = NOW()
    WHERE id = $1
    RETURNING role_guess, intent_main, country_interest, candidates_planned, stage
  `;
  const vals = [
    sessionId,
    facts.role_guess ?? null,
    facts.intent_main ?? null,
    facts.country_interest ?? null,
    facts.candidates_planned ?? null,
    facts.stage ?? null
  ];
  const { rows } = await db.query(q, vals);
  return rows[0];
}
