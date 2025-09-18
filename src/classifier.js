// /src/classifier.js

// Нормализация
export function norm(s = "") {
  return (s || "")
    .replace(/\s+/g, " ")
    .replace(/[«»“”"'\u00A0]/g, '"')
    .trim()
    .toLowerCase();
}

/* ─────────────────────────────────────────
   Триггеры-команды
────────────────────────────────────────── */
export function isCmdTeach(raw = "") {
  return /^ответил[аи]?\s*бы\s*[:\-]/i.test(raw.trim());
}
export function parseCmdTeach(raw = "") {
  const m = raw.match(/^ответил[аи]?\s*бы\s*[:\-]\s*(.+)$/is);
  return m ? m[1].trim() : null;
}

export function isCmdTranslate(raw = "") {
  return /^переведи(\s+на\s+[a-zA-ZА-Яа-яёіїєґ]+)?\s*[:\-]?\s*/i.test(raw.trim());
}
export function parseCmdTranslate(raw = "") {
  const re = /^переведи(?:\s+на\s+([a-zA-ZА-Яа-яёіїєґ]+))?\s*[:\-]?\s*(.*)$/is;
  const m = raw.trim().match(re);
  const lang = (m?.[1] || "").trim().toLowerCase() || null;
  const text = (m?.[2] || "").trim() || "";
  return { targetLangWord: lang, text };
}

export function isCmdAnswerExpensive(raw = "") {
  const s = norm(raw);
  return (
    s.startsWith("ответь на дорого") ||
    s.startsWith("ответь: агент говорит что дорого") ||
    s.startsWith("ответь агент говорит что дорого")
  );
}
export function isCmdAnswerGeneric(raw = "") {
  return /^ответь\s+на\s+/i.test(raw.trim());
}

/* ─────────────────────────────────────────
   Классификатор (rule-based фолбэк)
────────────────────────────────────────── */
export async function classifyCategoryRuleBased(text = "") {
  const t = norm(text);
  if (t.includes("дорог") || t.includes("price")) return "expensive";
  if (t.includes("после виз") || t.includes("after visa")) return "after_visa";
  if (t.includes("контракт") || t.includes("agreement")) return "contract";
  if (t.includes("деманд") || t.includes("vacanc")) return "demands";
  return "general";
}
export const classifyCategory = classifyCategoryRuleBased;

/* ─────────────────────────────────────────
   Детект контактов
────────────────────────────────────────── */
export function detectPhone(text) {
  const m = text?.match(/\+?[0-9][0-9 \-()]{6,}/);
  return m ? m[0].replace(/[^\d+]/g, "") : null;
}
export function detectName(text) {
  const m = text?.match(
    /\b(меня зовут|i am|my name is|мене звати|mam na imię|jmenuji se)\s+([A-ZА-ЯЁЇІЄҐŁŚŻŹĆŃÓĎŠČŘÝÁÍÉÜÖÄ][\p{L}\-']{1,}\s*[A-ZА-ЯЁЇІЄҐŁŚŻŹĆŃÓĎŠČŘÝÁÍÉÜÖÄ\p{L}\-']*)/iu
  );
  return m ? m[2].trim() : null;
}

/* ─────────────────────────────────────────
   Грубая оценка пола по имени
   (лучше покрыть словарём позже)
────────────────────────────────────────── */
const FEMALE_ENDINGS = [
  "а","я","ia","iia","na","ta","ra","la","sha","scha","ska","eva","eva","ina","yna","ena","onna","anna","alla","ella","maria","olga","irina","natalia","natalya","oksana","tatiana","tetiana","svetlana","svitlana","alena","alenka","sofia","sofia","sofiya","zofia","anna","ewa","ewa","agnieszka","kasia","katarzyna","ola","aleksandra","veronika","veronica","veronika"
];
export function guessGenderByName(nameRaw = "") {
  const name = norm(nameRaw);
  if (!name) return null;
  // короткий словарь исключений
  const maleList = ["alexander","oleksandr","aleksandr","andrzej","jan","tomas","marek","piotr","pavel","pawel","michal","mikhail","sergey","serhii","vasyl","viktor","viktorii" /* last one ambiguous */];
  if (maleList.includes(name.split(" ")[0])) return "male";

  const ending = name.split(" ")[0];
  if (FEMALE_ENDINGS.some((s) => ending.endsWith(s))) return "female";
  return "male"; // дефолт
}

/* ─────────────────────────────────────────
   Обращение по языку
────────────────────────────────────────── */
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
