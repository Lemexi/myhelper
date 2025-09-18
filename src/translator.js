// /src/translator.js
import { pool } from './db.js';
import { runLLM } from './llm.js';

// Маппинг слов на коды
const LangMap = {
  'английский': 'en', 'english': 'en', 'eng': 'en',
  'чешский': 'cz', 'czech': 'cz', 'cz': 'cz',
  'польский': 'pl', 'polish': 'pl', 'pl': 'pl',
  'украинский': 'uk', 'ukrainian': 'uk', 'uk': 'uk',
  'русский': 'ru', 'russian': 'ru', 'ru': 'ru',
};

// Простой кэш переводов (RU→X и X→RU)
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
    { role: 'system', content: 'You are a professional translator. Translate preserving meaning, tone and style.' },
    { role: 'user', content: `Translate from ${sourceLang} to ${targetLang}: ${text}` }
  ]);

  const ins = `
    INSERT INTO translations_cache (source_text, source_lang, target_lang, translated_text, by_model)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT DO NOTHING
  `;
  await pool.query(ins, [text, sourceLang, targetLang, translated, 'groq']);
  return { text: translated, cached: false };
}

// Перевод с "усилением" (переписать под психологию влияния) + русская подсказка
export async function translateWithStyle({ sourceText, targetLang, fallbackTarget='en' }) {
  const target = (targetLang && LangMap[targetLang]) || fallbackTarget;
  // 1) Переписываем в целевой язык с учётом тона WhatsApp и мягких триггеров влияния
  const { text: targetStyled } = await runLLM([
    { role: 'system', content: 'Rewrite the text for B2B WhatsApp: brief (1–4 sentences), confident, helpful, persuasive but ethical. Use soft Cialdini principles (1–2 max). Output only the rewritten text in the target language.' },
    { role: 'user', content: `Target language: ${target}. Text:\n${sourceText}` }
  ]);

  // 2) Даём менеджеру русскую версию того, что отправим клиенту
  const { text: targetRu } = await runLLM([
    { role: 'system', content: 'Translate preserving meaning and tone.' },
    { role: 'user', content: `Translate to ru: ${targetStyled}` }
  ]);

  return { targetLang: target, styled: targetStyled, styledRu: targetRu };
}

// Публичный помощник: нормализуем слово языка в код
export function resolveTargetLangCode(word) {
  if (!word) return null;
  const key = (word || '').toLowerCase();
  return LangMap[key] || null;
}
