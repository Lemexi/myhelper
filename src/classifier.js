// /src/classifier.js

// Простой rule-based классификатор (готов к замене на LLM при желании)
export async function classifyCategoryRuleBased(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('дорог') || t.includes('price')) return 'expensive';
  if (t.includes('после виз') || t.includes('after visa')) return 'after_visa';
  if (t.includes('контракт') || t.includes('agreement')) return 'contract';
  if (t.includes('деманд') || t.includes('vacanc')) return 'demands';
  return 'general';
}

// Экспорт, чтобы при переходе на LLM можно было одной строкой заменить
export const classifyCategory = classifyCategoryRuleBased;

// Детект контактов
export function detectPhone(text) {
  const m = text?.match(/\+?[0-9][0-9 \-()]{6,}/);
  return m ? m[0].replace(/[^\d+]/g, '') : null;
}
export function detectName(text) {
  const m = text?.match(/\b(меня зовут|i am|my name is)\s+([A-ZА-ЯЁЇІЄҐ][\p{L}\-']{1,}\s*[A-ZА-ЯЁЇІЄҐ\p{L}\-']*)/iu);
  return m ? m[2].trim() : null;
}
