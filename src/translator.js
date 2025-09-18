// /src/translator.js
import { pool } from "./db.js";
import { runLLM } from "./llm.js";

/* ─────────────────────────────────────────
   Языковые коды и маппинг слов → кодов
────────────────────────────────────────── */
const LangMap = {
  "английский": "en", english: "en", eng: "en", en: "en",
  "чешский": "cz", czech: "cz", cz: "cz", cs: "cz",
  "польский": "pl", polish: "pl", pl: "pl",
  "украинский": "uk", ukrainian: "uk", uk: "uk",
  "русский": "ru", russian: "ru", ru: "ru",
};
export function resolveTargetLangCode(word) {
  if (!word) return null;
  const key = (word || "").toLowerCase();
  return LangMap[key] || null;
}

/* ─────────────────────────────────────────
   Определение языка (через LLM)
────────────────────────────────────────── */
export async function detectLanguage(text) {
  const { text: out } = await runLLM([
    { role: "system", content: "Detect language code (en,ru,uk,pl,cz). Output only the code." },
    { role: "user", content: text.slice(0, 500) }
  ], { max_tokens: 5 });
  const code = (out || "en").trim().toLowerCase();
  return ["en","ru","uk","pl","cz"].includes(code) ? code : "en";
}

/* ─────────────────────────────────────────
   Кэш перевода (любой → любой)
────────────────────────────────────────── */
export async function translateCached(text, sourceLang, targetLang) {
  if (!text || sourceLang === targetLang) return { text, cached: true };

  const sel = `
    SELECT translated_text
    FROM translations_cache
    WHERE source_lang=$1 AND target_lang=$2 AND md5(source_text)=md5($3)
    LIMIT 1
  `;
  const hit = await pool.query(sel, [sourceLang, targetLang, text]);
  if (hit.rows.length) return { text: hit.rows[0].translated_text, cached: true };

  const { text: translated } = await runLLM([
    { role: "system", content: "You are a professional translator. Translate preserving meaning and tone." },
    { role: "user", content: `Translate from ${sourceLang} to ${targetLang}: ${text}` }
  ]);

  const ins = `
    INSERT INTO translations_cache (source_text, source_lang, target_lang, translated_text, by_model)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT DO NOTHING
  `;
  await pool.query(ins, [text, sourceLang, targetLang, translated, "groq"]);
  return { text: translated, cached: false };
}

/* ─────────────────────────────────────────
   Канонизация: всё в EN
────────────────────────────────────────── */
export async function toEnglishCanonical(text) {
  const src = await detectLanguage(text);
  if (src === "en") return { canonical: text, sourceLang: "en", original: text };
  const { text: canonical } = await translateCached(text, src, "en");
  return { canonical, sourceLang: src, original: text };
}

/* ─────────────────────────────────────────
   Перевод с «усилением» для клиента + RU для менеджера
────────────────────────────────────────── */
export async function translateWithStyle({ sourceText, targetLang }) {
  const target = targetLang || "en";
  const { text: styled } = await runLLM([
    { role: "system", content: "Rewrite the text for B2B WhatsApp: brief (1–4 sentences), confident, helpful, persuasive but ethical. Use soft Cialdini principles (1–2 max). Output only the rewritten text in the target language." },
    { role: "user", content: `Target language: ${target}. Text:\n${sourceText}` }
  ]);

  const { text: styledRu } = await runLLM([
    { role: "system", content: "Translate preserving meaning and tone." },
    { role: "user", content: `Translate to ru: ${styled}` }
  ]);

  return { targetLang: target, styled, styledRu };
}
