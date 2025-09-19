// /src/memory.js
// Profile helpers: name + facts persisted in public.sessions
// Мы храним источник имени в sessions.meta.user_name_source:
//   - "declared" — клиент сам назвал имя (можно показывать в тексте)
//   - "tg_meta"  — имя взято из Telegram (используем только внутри, не отображаем)

import { pool } from "./db.js";

/** Read lightweight session profile for prompts/rules */
export async function getSessionProfile(sessionId) {
  const { rows } = await pool.query(
    `SELECT id,
            user_name, user_surname, user_phone, user_email,
            role_guess, intent_main, country_interest, candidates_planned,
            psychotype, style_notes, stage, trust_score,
            meta
       FROM public.sessions
      WHERE id = $1`,
    [sessionId]
  );
  return rows[0] || null;
}

/** Best-effort declared name parser (multi-lang cues) */
function extractDeclaredName(text = "") {
  const s = String(text || "").trim();

  // "Меня зовут Виктор", "My name is Victor", "I am Victor",
  // "Мене звати ...", "Mam na imię ...", "Jmenuji se ..."
  const patterns = [
    /\bменя\s+зовут\s+([A-ZА-ЯЁ][\p{L}'-]{1,})(?:\s+[A-ZА-ЯЁ][\p{L}'-]{1,})?/iu,
    /\bmy\s+name\s+is\s+([A-Z][\p{L}'-]{1,})(?:\s+[A-Z][\p{L}'-]{1,})?/iu,
    /\bi\s+am\s+([A-Z][\p{L}'-]{1,})(?:\s+[A-Z][\p{L}'-]{1,})?/iu,
    /\bмене\s+звати\s+([A-ZА-ЯІЇЄ][\p{L}'-]{1,})/iu,
    /\bmam\s+na\s+imi[eę]\s+([A-Z][\p{L}'-]{1,})/iu,
    /\bjmenuji\s+se\s+([A-Z][\p{L}'-]{1,})/iu
  ];

  for (const re of patterns) {
    const m = s.match(re);
    if (m && m[1]) return m[1].trim();
  }

  // Fallback: короткое "Я Виктор" / "I'm Victor"
  const short = s.match(/\b(?:я|i'?m)\s+([A-ZА-ЯЁ][\p{L}'-]{1,})/iu);
  if (short && short[1]) return short[1].trim();

  return null;
}

/** Extract best Telegram display name (internal-only) */
function extractTGName(tgMeta = {}) {
  // поддерживаем разные обёртки апдейтов
  const from =
    tgMeta?.from ||
    tgMeta?.message?.from ||
    tgMeta?.effective_user ||
    tgMeta?.user ||
    null;

  const first = from?.first_name?.trim();
  const last  = from?.last_name?.trim();
  const user  = from?.username?.trim();

  return first || user || last || null;
}

/**
 * Ensure we have a name saved.
 * Priority: declared in message > telegram meta (only if not declared yet).
 * Side effect: writes meta.user_name_source = "declared" | "tg_meta"
 */
export async function ensureName(sessionId, userMessage, tgMeta) {
  const { rows } = await pool.query(
    `SELECT user_name, meta
       FROM public.sessions
      WHERE id=$1`,
    [sessionId]
  );
  const currentName = rows[0]?.user_name?.trim() || "";
  const meta        = rows[0]?.meta || {};
  const currentSrc  = (meta?.user_name_source || "").toLowerCase();

  // 1) попробуем вытащить имя из текста пользователя
  const declared = extractDeclaredName(userMessage || "");

  if (declared) {
    if (declared.toLowerCase() !== currentName.toLowerCase() || currentSrc !== "declared") {
      await pool.query(
        `UPDATE public.sessions
            SET user_name = $2,
                meta = COALESCE(meta, '{}'::jsonb)
                       || jsonb_build_object('user_name_source','declared'),
                updated_at = NOW()
          WHERE id = $1`,
        [sessionId, declared]
      );
    }
    return declared; // это имя можно отображать
  }

  // 2) если имени из текста нет — можно тихо положить из Telegram,
  //    но только если ещё нет declared-имени
  if (!currentName || currentSrc !== "declared") {
    const tgName = extractTGName(tgMeta);
    if (tgName) {
      await pool.query(
        `UPDATE public.sessions
            SET user_name = COALESCE(user_name, $2), -- не затирать declared
                meta = COALESCE(meta, '{}'::jsonb)
                       || jsonb_build_object(
                            'user_name_source',
                            CASE WHEN COALESCE(meta->>'user_name_source','') = 'declared'
                                 THEN 'declared' ELSE 'tg_meta' END
                          ),
                updated_at = NOW()
          WHERE id = $1`,
        [sessionId, tgName]
      );
      // Возвращаем NULL, чтобы верхний слой не отображал это имя
      return null;
    }
  }

  // Ничего не нашли
  return null;
}

/** Upsert quick facts the bot learns during chat */
export async function upsertFacts(sessionId, facts = {}) {
  const q = `
    UPDATE public.sessions SET
      role_guess         = COALESCE($2, role_guess),
      intent_main        = COALESCE($3, intent_main),
      country_interest   = COALESCE($4, country_interest),
      candidates_planned = COALESCE($5, candidates_planned),
      stage              = COALESCE($6, stage),
      updated_at         = NOW()
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
  const { rows } = await pool.query(q, vals);
  return rows[0];
}