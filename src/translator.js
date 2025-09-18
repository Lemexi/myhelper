// /src/translator.js
import { pool } from "./db.js";
import { runLLM } from "./llm.js";

/** Простая детекция языка по алфавиту */
export function detectLanguage(text = "") {
  const t = (text || "").trim();
  if (!t) return "en";
  if (/[а-яёіїєґ]/i.test(t)) return "ru";    // рус/укр/бел (упрощенно)
  if (/[ąćęłńóśżź]/i.test(t)) return "pl";
  if (/[áčďéěíňóřšťúůýž]/i.test(t)) return "cz";
  if (/[a-z]/i.test(t) && !/[^\x00-\x7F]/.test(t)) return "en";
  return "en";
}

/** Чистый перевод в EN для "канонического" хранения (без вступлений и кавычек) */
export async function toEnglishCanonical(sourceText) {
  const sourceLang = detectLanguage(sourceText);
  if (sourceLang === "en") {
    return { canonical: sourceText, sourceLang, original: sourceText };
  }
  const messages = [
    { role: "system", content: "You are a precise translator. Translate to English only. No quotes, no prefixes, no explanations." },
    { role: "user", content: sourceText }
  ];
  const { text } = await runLLM(messages);
  // подстрахуемся от кавычек/префиксов
  const canonical = (text || "")
    .replace(/^"+|"+$/g, "")
    .replace(/^here is.*?:\s*/i, "")
    .trim();
  return { canonical, sourceLang, original: sourceText };
}

/** Кэшированный перевод с любым направлением */
export async function translateCached(text, sourceLang, targetLang) {
  if (!text) return { text: "", cached: true };
  if (!targetLang) targetLang = "en";

  // если языки совпадают — ничего не делаем
  if (sourceLang && targetLang && sourceLang.toLowerCase() === targetLang.toLowerCase()) {
    return { text, cached: true };
  }

  // попытка хита в кэше
  const sel = `
    SELECT translated_text FROM translations_cache
    WHERE source_lang=$1 AND target_lang=$2 AND md5(source_text)=md5($3)
    LIMIT 1
  `;
  const hit = await pool.query(sel, [sourceLang || detectLanguage(text), targetLang, text]);
  if (hit.rows.length) {
    return { text: hit.rows[0].translated_text, cached: true };
  }

  // перевод через LLM
  const messages = [
    { role: "system", content: `Translate from ${sourceLang || "auto"} to ${targetLang}. Output ONLY the translation. No quotes, no prefixes.` },
    { role: "user", content: text }
  ];
  const { text: translatedRaw } = await runLLM(messages);
  const translated = (translatedRaw || "")
    .replace(/^"+|"+$/g, "")
    .replace(/^here is.*?:\s*/i, "")
    .trim();

  // запись в кэш
  try {
    const ins = `
      INSERT INTO translations_cache (source_text, source_lang, target_lang, translated_text, by_model)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING
    `;
    await pool.query(ins, [text, sourceLang || detectLanguage(text), targetLang, translated, "groq"]);
  } catch (e) {
    console.error("[translateCached] cache insert error:", e.message);
  }

  return { text: translated, cached: false };
}

/**
 * Стильный перевод для боевого общения:
 *  - основной аккуратный вариант на targetLang,
 *  - его зеркальный русский,
 *  - (опционально) альтернативный тон + его русский.
 */
export async function translateWithStyle({ sourceText, targetLang = "en" }) {
  const srcLang = detectLanguage(sourceText);

  // 1) основной вариант на targetLang
  const baseSys =
    "You are a senior B2B communicator. Translate AND lightly adapt the message to sound natural, confident, polite and persuasive. Output only the final text. No quotes, no meta.";
  const baseReq = [
    { role: "system", content: baseSys },
    { role: "user", content: `Target language: ${targetLang}\n\nMessage:\n${sourceText}` }
  ];
  const { text: styledRaw } = await runLLM(baseReq);
  const styled = (styledRaw || "").replace(/^"+|"+$/g, "").trim();

  // 2) его русская зеркальная версия (для контроля и копирования)
  const { text: styledRu } = await translateCached(styled, targetLang, "ru");

  // 3) альтернативный тон (если модель решит иначе)
  const altReq = [
    { role: "system", content: baseSys },
    { role: "user", content: `Target language: ${targetLang}. Provide ONE alternative phrasing with a slightly different tone (briefer or firmer). Output only the text.\n\nMessage:\n${sourceText}` }
  ];
  const { text: altRaw } = await runLLM(altReq);
  let altStyled = (altRaw || "").replace(/^"+|"+$/g, "").trim();
  if (altStyled && altStyled.toLowerCase() !== styled.toLowerCase()) {
    // зеркалим альтернативу на русский
    const { text: altStyledRu } = await translateCached(altStyled, targetLang, "ru");
    return { targetLang, styled, styledRu, altStyled, altStyledRu };
  }

  // если альтернатива получилась идентичной — не возвращаем её
  return { targetLang, styled, styledRu, altStyled: null, altStyledRu: null };
}