// /src/classifier.js

// Нормализация команд (убираем регистр/пробелы/мусор)
export function norm(s = '') {
  return (s || '')
    .replace(/\s+/g, ' ')
    .replace(/[«»“”"'\u00A0]/g, '"')
    .trim()
    .toLowerCase();
}

// Триггеры-команды (работают где угодно в тексте)
export function isCmdTeach(raw = '') {
  // "ответил бы:" | "ответила бы:" | допускаем тире/скобки/пробелы
  return /^ответил[аи]?\s*бы\s*[:\-]/i.test(raw.trim());
}
export function parseCmdTeach(raw = '') {
  const m = raw.match(/^ответил[аи]?\s*бы\s*[:\-]\s*(.+)$/is);
  return m ? m[1].trim() : null;
}

export function isCmdTranslate(raw = '') {
  // "переведи ..." | "переведи на чешский: ..." | "переведи: ..."
  return /^переведи(\s+на\s+[a-zA-ZА-Яа-яёіїєґ]+)?\s*[:\-]?\s*/i.test(raw.trim());
}
export function parseCmdTranslate(raw = '') {
  // возвращаем { targetLang, text }
  const re = /^переведи(?:\s+на\s+([a-zA-ZА-Яа-яёіїєґ]+))?\s*[:\-]?\s*(.*)$/is;
  const m = raw.trim().match(re);
  const lang = (m?.[1] || '').trim().toLowerCase() || null;
  const text = (m?.[2] || '').trim() || '';
  return { targetLangWord: lang, text };
}

export function isCmdAnswerExpensive(raw = '') {
  // "ответь на дорого" | "ответь: агент говорит что дорого"
  const s = norm(raw);
  return s.startsWith('ответь на дорого') || s.startsWith('ответь: агент говорит что дорого') || s.startsWith('ответь агент говорит что дорого');
}
export function isCmdAnswerGeneric(raw = '') {
  // "ответь на XXX" (на будущее — под другие категории)
  return /^ответь\s+на\s+/i.test(raw.trim());
}

// Rule-based классификатор (остается как фолбэк)
export async function classifyCategoryRuleBased(text = '') {
  const t = norm(text);
  if (t.includes('дорог') || t.includes('price')) return 'expensive';
  if (t.includes('после виз') || t.includes('after visa')) return 'after_visa';
  if (t.includes('контракт') || t.includes('agreement')) return 'contract';
  if (t.includes('деманд') || t.includes('vacanc')) return 'demands';
  return 'general';
}

// Экспорт для использования
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
