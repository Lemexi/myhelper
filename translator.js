// /src/translator.js
import { pool } from './db.js';
import { runLLM } from './llm.js';

export async function translateCached(text, sourceLang, targetLang) {
  if (!text || sourceLang === targetLang) return { text, cached: true };

  const sel = `
    SELECT translated_text FROM translations_cache
    WHERE source_lang=$1 AND target_lang=$2 AND md5(source_text)=md5($3)
    LIMIT 1
  `;
  const hit = await pool.query(sel, [sourceLang, targetLang, text]);
  if (hit.rows.length) return { text: hit.rows[0].translated_text, cached: true };

  const { text: translated } = await runLLM([
    { role: 'system', content: 'You are a professional translator. Translate preserving meaning and tone.' },
    { role: 'user', content: `Translate from ${sourceLang} to ${targetLang}: ${text}` }
  ]);

  const ins = `
    INSERT INTO translations_cache (source_text, source_lang, target_lang, translated_text, by_model)
    VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING
  `;
  await pool.query(ins, [text, sourceLang, targetLang, translated, 'groq']);
  return { text: translated, cached: false };
}
