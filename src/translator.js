// /src/translator.js
import { pool } from "./db.js";
import { runLLM } from "./llm.js";

/* ── Маппинг флагов и слов → коды ── */
const FlagMap = {
  "🇬🇧":"en","🇺🇸":"en","🇨🇦":"en",
  "🇵🇱":"pl",
  "🇺🇦":"uk",
  "🇷🇺":"ru",
  "🇨🇿":"cz","🇨🇭":"cz" // упрощённо
};
const LangMap = {
  "английский":"en","англ":"en","на англ":"en", english:"en", eng:"en", en:"en",
  "чешский":"cz","чеськ":"cz","на чеш":"cz","чеш":"cz", czech:"cz", cz:"cz", cs:"cz",
  "польский":"pl","польск":"pl","на пол":"pl", polish:"pl", pl:"pl",
  "украинский":"uk","українською":"uk","на укр":"uk","укр":"uk", ukrainian:"uk", uk:"uk",
  "русский":"ru","російською":"ru","на рус":"ru","рус":"ru", russian:"ru", ru:"ru",
};
export function resolveTargetLangCode(word) {
  if (!word) return null;
  // если в слове есть эмодзи-флаг — берём его
  for (const ch of [...word]) {
    if (FlagMap[ch]) return FlagMap[ch];
  }
  const key = (word || "").toLowerCase().trim();
  return LangMap[key] || null;
}

/* ── Детект языка ── */
export async function detectLanguage(text) {
  const { text: out } = await runLLM([
    { role: "system", content: "Detect language code among: en,ru,uk,pl,cz. Output only the code." },
    { role: "user", content: String(text || "").slice(0, 500) }
  ], { max_tokens: 5 });
  const code = (out || "en").trim().toLowerCase();
  return ["en","ru","uk","pl","cz"].includes(code) ? code : "en";
}

/* ── Кэш перевода ── */
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
    { role: "system", content: "Translate faithfully with natural style. Output only the translated sentence(s), no explanations." },
    { role: "user", content: `Translate from ${sourceLang} to ${targetLang}:\n${text}` }
  ]);

  const ins = `
    INSERT INTO translations_cache (source_text, source_lang, target_lang, translated_text, by_model)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT DO NOTHING
  `;
  await pool.query(ins, [text, sourceLang, targetLang, translated, "groq"]);
  return { text: translated, cached: false };
}

/* ── Канонизация в EN ── */
export async function toEnglishCanonical(text) {
  const src = await detectLanguage(text);
  if (src === "en") return { canonical: String(text || ""), sourceLang: "en", original: String(text || "") };
  const { text: canonical } = await translateCached(String(text || ""), src, "en");
  return { canonical, sourceLang: src, original: String(text || "") };
}

/* ── Перевод c «маркетинговым стилем» (для ботового ответа) ── */
export async function translateWithStyle({ sourceText, targetLang }) {
  const target = (resolveTargetLangCode(targetLang) || targetLang || "en").toLowerCase();

  // Основной вариант (строго без пояснений)
  const { text: styled } = await runLLM([
    {
      role: "system",
      content:
        "Rewrite for B2B WhatsApp: 1–4 short sentences, confident, warm, persuasive but ethical; soft Cialdini (max 1–2). " +
        "Output ONLY the rewritten text in the target language. No headings, no quotes, no explanations."
    },
    { role: "user", content: `Target: ${target}\nText:\n${sourceText}` }
  ]);

  // Альтернатива (может вернуть пусто)
  const { text: altMaybe } = await runLLM([
    {
      role: "system",
      content:
        "Provide ONE alternative rephrase of the user's text in the same target language. " +
        "Keep 1–4 sentences, same constraints. If the original is already optimal, return exactly an empty string. " +
        "Output only the alternative text (or empty string)."
    },
    { role: "user", content: `Target: ${target}\nText:\n${sourceText}` }
  ]);

  // Русские версии для владельца
  const styledRu   = target === "ru" ? styled : (await translateCached(styled,   target, "ru")).text;
  const altClean   = (altMaybe || "").trim();
  const altStyled  = altClean ? altClean : "";
  const altStyledRu = altStyled ? (target === "ru" ? altStyled : (await translateCached(altStyled, target, "ru")).text) : "";

  return { targetLang: target, styled, styledRu, altStyled, altStyledRu };
}