// /src/classifier.js

/* ─────────── НОРМАЛИЗАЦИЯ ─────────── */
export function norm(s = "") {
  return (s || "")
    .replace(/\u00A0/g, " ")
    .replace(/[«»“”]/g, '"')
    .replace(/[’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
export function lower(s = "") { return norm(s).toLowerCase(); }

/* Телеграм присылает реплай с префиксами строк — вычистим «цитату» */
export function stripQuoted(raw = "") {
  if (!raw) return "";
  const lines = String(raw).split(/\r?\n/);
  const clean = [];
  for (const ln of lines) {
    const l = ln.trim();
    if (!l) continue;
    // 1) Прямая цитата > ...
    if (/^>/.test(l)) continue;
    // 2) Шапки reply-предпросмотра
    if (/^(from:|replying to)/i.test(l)) continue;
    if (/^assistant\b/i.test(l)) continue;
    if (/renovogo\.com/i.test(l)) continue;
    // 3) «прикреплённое» превью (часто заканчивается «…»)
    if (/^https?:\/\//i.test(l)) continue;
    clean.push(l);
  }
  return clean.join("\n").trim();
}

/* ─────────── КОМАНДЫ ─────────── */

/** «Я бы ответил/а …» — ловим любые варианты + "так:" */
export function isCmdTeach(raw = "") {
  const t = lower(stripQuoted(raw));
  // не требуем точных границ слова — разрешаем двоеточие/дефис/эмодзи сразу после
  return /(я\s*бы\s*ответил(а)?|я\s*ответил(а)?\s*бы|я\s*ответил(а)?|ответил(а)?\s*бы)(?=[\s:,\-]|$)/i.test(t);
}
export function parseCmdTeach(raw = "") {
  const t = stripQuoted(raw);
  // захватываем всё после маркера, включая "так:" (оно просто окажется в тексте)
  const re = /(я\s*бы\s*ответил(а)?|я\s*ответил(а)?\s*бы|я\s*ответил(а)?|ответил(а)?\s*бы)[\s:,\-]*([\s\S]+)$/i;
  const m = t.match(re);
  return m ? m[2].trim() : null;
}

/** Список «токенов перевода» */
const LANG_TOKENS = ["переведи","переклади","translate","translation","tl"];

/** «Переведи …» — допускаем двоеточие, «на язык», флаги, и просто флаг + текст */
export function isCmdTranslate(raw = "") {
  const hasFlag = /([\u{1F1E6}-\u{1F1FF}]{2})/u.test(raw); // эмодзи-флаги
  const t = lower(stripQuoted(raw));
  const hasToken = LANG_TOKENS.some(k => t.startsWith(k) || t.includes(` ${k} `));
  return hasFlag || hasToken;
}

/** Разбор перевода: возвращаем { targetLangWord, text } */
export function parseCmdTranslate(raw = "") {
  const original = stripQuoted(raw);

  // 1) Если есть флаг — возьмём первый
  const flagMatch = original.match(/([\u{1F1E6}-\u{1F1FF}]{2})/u);
  const flag = flagMatch ? flagMatch[1] : null;

  // 2) Паттерн с «переведи/переклади/translate [на|to] <язык> : <текст>»
  const re =
    /(?:переведи|переклади|translate(?:\s+to)?)\s*(?:на|to)?\s*([A-Za-zА-Яа-яЁёЇїІіЄєҐґ\. ]{0,30})[\s:,\-]*([\s\S]*)$/i;
  const m = original.match(re);
  const langWord = (m?.[1] || "").trim();
  let textPart = (m?.[2] || "").trim();

  // 3) Если токена нет, а есть флаг — формат «🇬🇧 Текст…»
  if (!m && flag) {
    textPart = norm(original.replace(flag, ""));
  }

  // 4) Итоговый язык-слово: флаг приоритетнее
  const targetLangWord = (flag || langWord || "").trim() || null;

  return { targetLangWord, text: textPart };
}

/* ─────────── КЛАССИФИКАЦИЯ (fallback-правила) ─────────── */
export async function classifyCategoryRuleBased(text = "") {
  const t = lower(text);
  if (t.includes("дорог") || t.includes("price")) return "expensive";
  if (t.includes("после виз") || t.includes("after visa")) return "after_visa";
  if (t.includes("контракт") || t.includes("agreement")) return "contract";
  if (t.includes("деманд") || t.includes("vacanc")) return "demands";
  return "general";
}
export const classifyCategory = classifyCategoryRuleBased;

/* ─────────── ПРИВЕТСТВИЯ ─────────── */
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

/* ─────────── ИМЯ/ТЕЛЕФОН ─────────── */
export function detectNameSentence(text) {
  const m = text?.match(
    /\b(меня зовут|i am|my name is|мене звати|mam na imię|jmenuji se)\s+([A-ZА-ЯЁЇІЄҐŁŚŻŹĆŃÓĎŠČŘÝÁÍÉÜÖÄ][\p{L}\-']{1,}\s*[A-ZА-ЯЁЇІЄҐŁŚŻŹĆŃÓĎŠČŘÝÁÍÉÜÖÄ\p{L}\-']*)/iu
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

/* ─────────── ПОЛ + ОБРАЩЕНИЕ ─────────── */
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
