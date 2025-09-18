// /src/classifier.js

// Нормализация
export function norm(s = "") {
  return (s || "")
    .replace(/\s+/g, " ")
    .replace(/[«»“”"'\u00A0]/g, '"')
    .trim();
}
export function lower(s = "") {
  return norm(s).toLowerCase();
}

/* ─────────── Триггеры-команды ─────────── */

// Принять любые формы: "Ответил бы", "Я бы ответил", "Я ответила бы", с/без ":" и знаков
export function isCmdTeach(raw = "") {
  const t = lower(raw);
  return /^(?:я\s*бы\s*ответил[аи]?|я\s*ответил[аи]?\s*бы|ответил[аи]?\s*бы)\b/.test(t);
}
export function parseCmdTeach(raw = "") {
  // Берём всё после ключевой фразы, допускаем ":" / "-" / "," / пробелы
  const m = raw.match(/^(?:я\s*бы\s*ответил[аи]?|я\s*ответил[аи]?\s*бы|ответил[аи]?\s*бы)\s*[:\-,]?\s*(.+)$/is);
  return m ? m[1].trim() : null;
}

// "Переведи ..." / "Переведи на чешский ..." — с/без двоеточия
export function isCmdTranslate(raw = "") {
  return /^переведи(\s+на\s+[a-zA-ZА-Яа-яёіїєґ]+)?\b/i.test(norm(raw));
}
export function parseCmdTranslate(raw = "") {
  const re = /^переведи(?:\s+на\s+([a-zA-ZА-Яа-яёіїєґ]+))?\s*[:\-,]?\s*(.*)$/is;
  const m = norm(raw).match(re);
  const lang = (m?.[1] || "").trim().toLowerCase() || null;
  const text = (m?.[2] || "").trim() || "";
  return { targetLangWord: lang, text };
}

// "Ответь на дорого" + варианты
export function isCmdAnswerExpensive(raw = "") {
  const s = lower(raw);
  return (
    s.startsWith("ответь на дорого") ||
    s.startsWith("ответь: агент говорит что дорого") ||
    s.startsWith("ответь агент говорит что дорого")
  );
}
export function isCmdAnswerGeneric(raw = "") {
  return /^ответь\s+на\s+/i.test(norm(raw));
}

/* ─────────── Приветствия ─────────── */
const greetMap = [
  { re: /добрый\s*д(е|ё)нь/i, ru: "Добрый день", key: "good_day" },
  { re: /добрый\s*вечер/i,   ru: "Добрый вечер", key: "good_evening" },
  { re: /здравствуй(те)?/i,  ru: "Здравствуйте", key: "hello_formal" },
  { re: /привет/i,           ru: "Привет",       key: "hello_casual" },
  { re: /\bhello\b/i,        ru: "Hello",        key: "hello_en" },
  { re: /\bhi\b/i,           ru: "Hi",           key: "hi_en" }
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

/* ─────────── Контакты ─────────── */
export function detectPhone(text) {
  const m = text?.match(/\+?[0-9][0-9 \-()]{6,}/);
  return m ? m[0].replace(/[^\d+]/g, "") : null;
}

// Имя в форме "Меня зовут ..." / "My name is ..." и т.п.
export function detectName(text) {
  const m = text?.match(
    /\b(меня зовут|i am|my name is|мене звати|mam na imię|jmenuji se)\s+([A-ZА-ЯЁЇІЄҐŁŚŻŹĆŃÓĎŠČŘÝÁÍÉÜÖÄ][\p{L}\-']{1,}\s*[A-ZА-ЯЁЇІЄҐŁŚŻŹĆŃÓĎŠČŘÝÁÍÉÜÖÄ\p{L}\-']*)/iu
  );
  return m ? m[2].trim() : null;
}

// Имя как одно слово (напр. "Виктор")
export function detectStandaloneName(text) {
  const t = norm(text);
  // одно слово, только буквы, длина 2-30, начинается с заглавной
  if (/^[A-ZА-ЯЁЇІЄҐŁŚŻŹĆŃÓĎŠČŘÝÁÍÉÜÖÄ][A-Za-zА-Яа-яЁёЇїІіЄєҐґŁłŚśŻżŹźĆćŃńÓóĎďŠšČčŘřÝýÁáÍíÉéÜüÖöÄä\-']{1,29}$/.test(t)) {
    return t;
  }
  return null;
}

/* ─────────── Пол по имени + обращение ─────────── */
const FEMALE_ENDINGS = [
  "а","я","ia","iia","na","ta","ra","la","sha","scha","ska",
  "eva","ina","yna","ena","onna","anna","alla","ella",
  "maria","olga","irina","natalia","natalya","oksana","tatiana","tetiana",
  "svetlana","svitlana","alena","sofia","zofia","ewa","agnieszka","kasia","katarzyna","aleksandra","veronika","veronica"
];
export function guessGenderByName(nameRaw = "") {
  const name = lower(nameRaw);
  if (!name) return null;
  const maleList = ["alexander","oleksandr","aleksandr","andrzej","jan","tomas","marek","piotr","pavel","pawel","michal","mikhail","sergey","serhii","vasyl","viktor"];
  if (maleList.includes(name.split(" ")[0])) return "male";
  const first = name.split(" ")[0];
  if (FEMALE_ENDINGS.some((s) => first.endsWith(s))) return "female";
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
