// /src/classifier.js

// Нормализация и чистка цитат/префиксов
export function norm(s = "") {
  return (s || "").replace(/\s+/g, " ").replace(/[«»“”"'\u00A0]/g, '"').trim();
}
export function lower(s = "") { return norm(s).toLowerCase(); }
export function stripQuoted(raw = "") {
  const lines = (raw || "").split(/\r?\n/);
  const clean = [];
  for (const ln of lines) {
    const l = ln.trim();
    if (!l) continue;
    if (l.startsWith(">")) continue;                                   // цитаты
    if (/^assistant\b|renovogo\.com|^bot\b|^from:|^replying to/i.test(l)) continue; // шапки
    clean.push(l);
  }
  return clean.join("\n").trim();
}

/* ─────────── Триггеры-команды ─────────── */

// === КОМАНДА "Я БЫ ОТВЕТИЛ/А" ===
// Принимаем любые формы: порядок слов, женскую форму, и без "бы"
export function isCmdTeach(raw = "") {
  const t = lower(stripQuoted(raw));
  return /\b(я\s*бы\s*ответил(а)?|я\s*ответил(а)?\s*бы|ответил(а)?\s*бы|я\s*ответил(а)?)(?=\s|:|,|-|$)/i.test(t);
}
export function parseCmdTeach(raw = "") {
  const t = stripQuoted(raw);
  const re = /(я\s*бы\s*ответил(а)?|я\s*ответил(а)?\s*бы|ответил(а)?\s*бы|я\s*ответил(а)?)[\s:,\-]*([\s\S]+)$/i;
  const m = t.match(re);
  return m ? m[2].trim() : null;
}

// === КОМАНДА "ПЕРЕВЕДИ" (рус/укр/англ + флаги) ===
const LANG_TOKENS = [
  "переведи", "переклади", "translate", "translation", "tl"
];
// пара «региональных» флагов (эмодзи) — базовый признак наличия флага
const FLAG_PAIR_RE = /([\u{1F1E6}-\u{1F1FF}]{2})/u;

export function isCmdTranslate(raw = "") {
  const body = stripQuoted(raw);
  const t = lower(body);
  const hasKeyword = LANG_TOKENS.some(k => t.startsWith(k) || t.includes(` ${k} `));
  const hasFlag = FLAG_PAIR_RE.test(body);
  return hasKeyword || hasFlag;
}

export function parseCmdTranslate(raw = "") {
  const t = stripQuoted(raw);

  // 1) Язык по флагу (если есть — берём первый)
  const flagMatch = t.match(FLAG_PAIR_RE);
  const flag = flagMatch ? flagMatch[1] : null;

  // 2) "переведи/переклади/translate (to) на <язык>: <текст>"
  const re =
    /(?:переведи|переклади|translate(?:\s+to)?)(?:\s*(?:на|to)\s*([A-Za-zА-Яа-яёіїєґ\. ]{0,20}))?[\s:,\-]*([\s\S]*)$/i;
  const m = t.match(re);
  const langWord = (m?.[1] || "").trim();
  let text = (m?.[2] || "").trim();

  // 3) Фолбэк: если была конструкция "🇬🇧 <текст>" без ключевого слова
  if (!m && flag) {
    text = t.replace(flag, "").trim();
  }

  const targetLangWord = flag ? flag : (langWord || null);
  return { targetLangWord, text };
}

export function isCmdAnswerExpensive(raw = "") {
  const s = lower(stripQuoted(raw));
  return s.includes("ответь на дорого") || s.includes("агент говорит что дорого");
}
export function isCmdAnswerGeneric(raw = "") {
  return /^ответь\s+на\s+/i.test(stripQuoted(raw));
}

/* ─────────── Приветствия ─────────── */
const greetMap = [
  { re: /добрый\s*д(е|ё)нь/i, ru: "Добрый день" },
  { re: /добрый\s*вечер/i,   ru: "Добрый вечер" },
  { re: /здравствуй(те)?/i,  ru: "Здравствуйте" },
  { re: /привет/i,           ru: "Привет" },
  { re: /\bhello\b/i,        ru: "Hello" },
  { re: /\bhi\b/i,           ru: "Hi" }
];
export function extractGreeting(raw = "") {
  const hit = greetMap.find(g => g.re.test(raw));
  return hit ? hit.ru : null;
}

/* ─────────── Классификатор (фолбэк) ─────────── */
export async function classifyCategoryRuleBased(text = "") {
  const t = lower(text);
  if (t.includes("дорог") || t.includes("price")) return "expensive";
  if (t.includes("после виз") || t.includes("after visa")) return "after_visa";
  if (t.includes("контракт") || t.includes("agreement")) return "contract";
  if (t.includes("деманд") || t.includes("vacanc")) return "demands";
  return "general";
}
export const classifyCategory = classifyCategoryRuleBased;

/* ─────────── Имя / телефон ─────────── */
export function detectNameSentence(text) {
  const m = text?.match(
    /\b(меня зовут|i am|my name is|мене звати|mam na imię|jmenuji se)\s+([A-ZА-ЯЁЇІЄҐŁŚŻŹĆŃÓĎŠČŘÝÁÍÉÜÖÄ][\p{L}\-']{1,}\s*[A-ZА-ЯЁЇІЄҐŁŚŻŹĆŃÓĎŠŠČŘÝÁÍÉÜÖÄ\p{L}\-']*)/iu
  );
  return m ? m[2].trim() : null;
}
export function detectStandaloneName(text) {
  const t = norm(text);
  if (/^[A-ZА-ЯЁЇІЄҐŁŚŻŹĆŃÓĎŠČŘÝÁÍÉÜÖÄ][A-Za-zА-Яа-яЁёЇїІіЄєҐґŁłŚśŻżŹźĆćŃńÓóĎďŠšČčŘřÝýÁáÍíÉéÜüÖöÄä\-']{1,29}$/.test(t)) return t;
  return null;
}
export function detectLeadingName(text) {
  const m = norm(text).match(
    /^([A-ZА-ЯЁЇІЄҐŁŚŻŹĆŃÓĎŠČŘÝÁÍÉÜÖÄ][A-Za-zА-Яа-яЁёЇїІіЄєҐґŁłŚśŻżŹźĆćŃńÓóĎďŠšČčŘřÝýÁáÍíÉéÜüÖöÄä\-']{1,29})\s*[,—-]/u
  );
  return m ? m[1].trim() : null;
}
export function detectAnyName(text) {
  return detectNameSentence(text) || detectStandaloneName(text) || detectLeadingName(text);
}
export function detectPhone(text) {
  const m = text?.match(/\+?[0-9][0-9 \-()]{6,}/);
  return m ? m[0].replace(/[^\d+]/g, "") : null;
}

/* ─────────── Пол + обращение ─────────── */
const FEMALE_ENDINGS = ["а","я","ia","iia","na","ta","ra","la","sha","scha","ska","eva","ina","yna","ena","onna","anna","alla","ella","maria","olga","irina","natalia","natalya","oksana","tatiana","tetiana","svetlana","svitlana","alena","sofia","zofia","ewa","agnieszka","kasia","katarzyna","aleksandra","veronika","veronica"];
export function guessGenderByName(nameRaw = "") {
  const first = lower(nameRaw).split(" ")[0];
  if (!first) return null;
  const maleList = ["alexander","oleksandr","aleksandr","andrzej","jan","tomas","marek","piotr","pavel","pawel","michal","mikhail","sergey","serhii","vasyl","viktor"];
  if (maleList.includes(first)) return "male";
  if (FEMALE_ENDINGS.some(s => first.endsWith(s))) return "female";
  return "male";
}
export function honorific(lang = "ru", gender = "male") {
  const isF = gender === "female";
  switch ((lang || "ru").toLowerCase()) {
    case "ru": return isF ? "Мэм" : "Сэр";
    case "uk": return isF ? "Пані" : "Пане";
    case "pl": return isF ? "Pani" : "Panie";
    case "cz":
    case "cs": return isF ? "Paní" : "Pane";
    case "en": default: return isF ? "Ma’am" : "Sir";
  }
}
