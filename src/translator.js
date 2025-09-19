// /src/translator.js
import { pool } from "./db.js";
import { runLLM } from "./llm.js";

/* ─────────────────────────────────────────────────────────────
 * НОРМАЛИЗАЦИЯ ЯЗЫКОВ
 * ────────────────────────────────────────────────────────────*/

// Синонимы → ISO коды; чешский нормализуем в cs
const LangMap = {
  // English
  "английский": "en", english: "en", eng: "en", en: "en",
  // Russian
  "русский": "ru", russian: "ru", ru: "ru",
  // Polish
  "польский": "pl", polish: "pl", "po polsku": "pl", pl: "pl",
  // Czech (normalize cz→cs)
  "чешский": "cs", czech: "cs", cz: "cs", cs: "cs", český: "cs", česky: "cs",
  // Ukrainian
  "украинский": "uk", ukrainian: "uk", uk: "uk", "по-украински": "uk",
  // Extras we may mention (fallback handled elsewhere)
  arabic: "ar", "арабский": "ar", ar: "ar",
  hebrew: "he", "иврит": "he", he: "he"
};

export function resolveTargetLangCode(word) {
  if (!word || !word.trim()) return "en";
  const key = word.toLowerCase().trim();
  return LangMap[key] || key.slice(0, 2) || "en";
}

// Нормализуем входной код (включая cz→cs)
function normalizeLang(code) {
  if (!code) return "en";
  const c = String(code).toLowerCase();
  if (c === "cz") return "cs";
  if (c.startsWith("en")) return "en";
  if (c.startsWith("ru")) return "ru";
  if (c.startsWith("pl")) return "pl";
  if (c.startsWith("cs") || /čes|cesk/i.test(c)) return "cs";
  if (c.startsWith("uk")) return "uk";
  if (c.startsWith("ar")) return "ar";
  if (c.startsWith("he")) return "he";
  return c.slice(0, 2);
}

/* ─────────────────────────────────────────────────────────────
 * ДЕТЕКТ ЯЗЫКА
 * ────────────────────────────────────────────────────────────*/

export async function detectLanguage(text) {
  const sample = (text || "").slice(0, 500);
  if (!sample.trim()) return "en";

  // Просим LLM вернуть только ISO-код (две буквы, или cs/uk/he/ar)
  const { text: out } = await runLLM(
    [
      {
        role: "system",
        content:
          "Detect the language of the USER text and output ONLY an ISO code from this set: " +
          "en, ru, pl, cs, uk, ar, he. If unsure, output en. No extra words."
      },
      { role: "user", content: sample }
    ],
    { max_tokens: 6 }
  );

  const raw = (out || "en").trim().toLowerCase();
  const code = normalizeLang(raw);
  return ["en", "ru", "pl", "cs", "uk", "ar", "he"].includes(code) ? code : "en";
}

/* ─────────────────────────────────────────────────────────────
 * КЭШ ПЕРЕВОДОВ
 * ────────────────────────────────────────────────────────────*/

export async function translateCached(text, sourceLang, targetLang) {
  if (!text) return { text: "", cached: true };
  const src = normalizeLang(sourceLang);
  const tgt = normalizeLang(targetLang);

  if (src === tgt) return { text, cached: true };

  const sel = `
    SELECT translated_text
    FROM translations_cache
    WHERE source_lang=$1 AND target_lang=$2 AND md5(source_text)=md5($3)
    LIMIT 1
  `;
  const hit = await pool.query(sel, [src, tgt, text]);
  if (hit.rows.length) return { text: hit.rows[0].translated_text, cached: true };

  const { text: translated } = await runLLM([
    { role: "system", content: "Translate faithfully with natural style. Output only the translated text, no explanations." },
    { role: "user", content: `Translate from ${src} to ${tgt}:\n${text}` }
  ]);

  const ins = `
    INSERT INTO translations_cache (source_text, source_lang, target_lang, translated_text, by_model)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT DO NOTHING
  `;
  await pool.query(ins, [text, src, tgt, translated, "groq"]);
  return { text: translated, cached: false };
}

/* ─────────────────────────────────────────────────────────────
 * КАНОНИЗАЦИЯ: ВСЁ В EN
 * ────────────────────────────────────────────────────────────*/

export async function toEnglishCanonical(text) {
  const src = normalizeLang(await detectLanguage(text));
  if (src === "en") return { canonical: text, sourceLang: "en", original: text };
  const { text: canonical } = await translateCached(text, src, "en");
  return { canonical, sourceLang: src, original: text };
}

/* ─────────────────────────────────────────────────────────────
 * ПЕРЕВОД С «УСИЛЕНИЕМ» ДЛЯ WHATSAPP-СТИЛЯ
 * ────────────────────────────────────────────────────────────*/

export async function translateWithStyle({ sourceText, targetLang }) {
  const target = normalizeLang(targetLang || "en");

  const { text: styledRaw } = await runLLM([
    {
      role: "system",
      content:
        "You are a senior B2B copywriter for WhatsApp/Email. Rewrite the user's message in TARGET language.\n" +
        "Goals: clarity, credibility, warmth; ethical persuasion (Cialdini 1–2 cues max); concrete benefits; soft CTA if natural.\n" +
        "Constraints: 1–4 short sentences, no fluff, no headers, no labels, no quotes, no explanations.\n" +
        "Output ONLY the rewritten text."
    },
    { role: "user", content: `TARGET=${target}\nTEXT:\n${sourceText}` }
  ]);

  // убрать возможные лейблы типа "Translation:"
  let styled = (styledRaw || "").trim()
    .replace(/^(english|polish|russian|ukrainian|czech)?\s*translation\s*:\s*/i, "")
    .replace(/^(перевод)\s*:\s*/i, "")
    .trim();
  if ((styled.startsWith('"') && styled.endsWith('"')) || (styled.startsWith("“") && styled.endsWith("”"))) {
    styled = styled.slice(1, -1).trim();
  }

  const styledRu = target === "ru" ? styled : (await translateCached(styled, target, "ru")).text;

  return { targetLang: target, styled, styledRu, altStyled: "", altStyledRu: "" };
}