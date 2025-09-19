// /src/translator.js
import { pool } from "./db.js";
import { runLLM } from "./llm.js";

/* ── Маппинг слов → коды ── */
const LangMap = {
  "английский": "en", english: "en", eng: "en", en: "en",
  "чешский": "cz", czech: "cz", cz: "cz", cs: "cz",
  "польский": "pl", polish: "pl", pl: "pl",
  "украинский": "uk", ukrainian: "uk", uk: "uk",
  "русский": "ru", russian: "ru", ru: "ru",
};

export function resolveTargetLangCode(word) {
  if (!word || word.trim() === "") return "en"; // По умолчанию английский
  const key = word.toLowerCase().trim();
  return LangMap[key] || "en"; // Если язык не найден, тоже английский
}

/* ── Детект языка ── */
export async function detectLanguage(text) {
  const { text: out } = await runLLM(
    [
      { role: "system", content: "Detect language code among: en,ru,uk,pl,cz. Output only the code." },
      { role: "user", content: (text || "").slice(0, 500) }
    ],
    { max_tokens: 5 }
  );
  const code = (out || "en").trim().toLowerCase();
  return ["en", "ru", "uk", "pl", "cz"].includes(code) ? code : "en";
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

/* ── Канонизация: всё в EN ── */
export async function toEnglishCanonical(text) {
  const src = await detectLanguage(text);
  if (src === "en") return { canonical: text, sourceLang: "en", original: text };
  const { text: canonical } = await translateCached(text, src, "en");
  return { canonical, sourceLang: src, original: text };
}

/* ── Перевод с «усилением»: B2B-ритм, влияние/маркетинг ── */
export async function translateWithStyle({ sourceText, targetLang }) {
  const target = (targetLang || "en").toLowerCase();

  const { text: styledRaw } = await runLLM([
    {
      role: "system",
      content:
        "You are a senior B2B copywriter for WhatsApp/Email. Rewrite the user's message in the TARGET language.\n" +
        "Goals: high clarity, credibility, warmth; persuasive but ethical; subtle Cialdini (1–2 cues max);\n" +
        "use neuromarketing micro-cues, concrete benefits, and a soft CTA if natural.\n" +
        "Constraints: 1–4 short sentences, no fluff, no headers, no quotes, no labels, no explanations.\n" +
        "Output ONLY the rewritten text in the target language."
    },
    { role: "user", content: `TARGET=${target}\nTEXT:\n${sourceText}` }
  ]);

  // Подчистим возможные лейблы типа "Translation:"
  let styled = (styledRaw || "").trim();
  styled = styled.replace(/^(english translation|translation|перевод)\s*:\s*/i, "").trim();
  if ((styled.startsWith('"') && styled.endsWith('"')) || (styled.startsWith("“") && styled.endsWith("”"))) {
    styled = styled.slice(1, -1).trim();
  }

  const styledRu = target === "ru" ? styled : (await translateCached(styled, target, "ru")).text;

  return { targetLang: target, styled, styledRu, altStyled: "", altStyledRu: "" };
}
