// Нормализация и чистка цитат/префиксов
export function norm(s = "") {
  // аккуратно приводим пробелы и кавычки
  return (s || "")
    .replace(/\s+/g, " ")
    .replace(/[«»”"'\u00A0]/g, '"')
    .trim();
}

export function lower(s = "") { return norm(s).toLowerCase(); }

export function stripQuoted(raw = "") {
  const lines = (raw || "").split(/\r?\n/);
  const clean = [];
  for (const ln of lines) {
    const l = ln.trim();
    if (!l) continue;
    if (l.startsWith(">")) continue; // цитаты
    if (/^assistant\b|renovogo\.com|^bot\b|^from:|^replying to/i.test(l)) continue; // шапки
    clean.push(l);
  }
  return clean.join("\n").trim();
}

/* ─────────── Триггеры-команды ─────────── */

// «Я бы ответил/а …» — ловим варианты порядка слов и женскую форму
export function isCmdTeach(raw = "") {
  const t = lower(raw);
  return /(?:^|\s)(?:я\s+бы\s+ответил[ао]?|я\s+ответил[ао]?\s+бы|ответил[ао]?\s+бы\s+я|ответил[ао]?\s+бы)(?:\s|$)/i.test(t);
}

export function parseCmdTeach(raw = "") {
  const t = stripQuoted(raw);
  const patterns = [
    /(?:я\s+бы\s+ответил[ао]?|я\s+ответил[ао]?\s+бы|ответил[ао]?\s+бы\s+я)\s*:?\s*["']?([\s\S]+)["']?$/i,
    /ответил[ао]?\s+бы\s*:?\s*["']?([\s\S]+)["']?$/i,
    /(?:я\s+бы\s+ответил[ао]?|я\s+ответил[ао]?\s+бы|ответил[ао]?\s+бы\s+я)\s*:?\s*([\s\S]+)$/i,
    /ответил[ао]?\s+бы\s*:?\s*([\s\S]+)$/i
  ];
  for (const pattern of patterns) {
    const m = t.match(pattern);
    if (m && m[1]) {
      const result = m[1].trim();
      if (result) return result;
    }
  }
  const cleaned = t.replace(/(?:я\s+бы\s+ответил[ао]?|я\s+ответил[ао]?\s+бы|ответил[ао]?\s+бы\s+я|ответил[ао]?\s+бы)\s*:?\s*/i, "").trim();
  if (cleaned !== t && cleaned) return cleaned;
  return null;
}

// Перевод: поддержим «переведи», «переклади», «translate (to)»
export function isCmdTranslate(raw = "") {
  const t = lower(raw);
  return /\b(переведи|переклади|translate)\b/.test(t);
}

export function parseCmdTranslate(raw = "") {
  const t = stripQuoted(raw);
  const re = /(?:переведи|переклади|translate)(?:\s+(?:на|to)\s+([A-Za-zА-Яа-яёіїєґ.\s]{1,20}))?\s*:?\s*([\s\S]*?)$/i;
  const m = t.match(re);
  let targetLangWord = null;
  let text = "";
  if (m) {
    targetLangWord = (m[1] || "").trim().toLowerCase() || null;
    text = (m[2] || "").trim();
  }
  return { targetLangWord, text };
}

export function isCmdAnswerExpensive(raw = "") {
  const s = lower(raw);
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
  { re: /\bhi\b/i,           ru: "Hi" },
  { re: /\bcześć\b/i,        ru: "Cześć" },
  { re: /\bwitam\b/i,        ru: "Witam" },
  { re: /\bahoj\b/i,         ru: "Ahoj" },
  { re: /dobrý\s*den/i,      ru: "Dobrý den" }
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

// стоп-слова, чтобы не путать «Привет»/«Hello»/и пр. с именем
const NAME_STOPWORDS = new Set([
  // RU/UK
  "привет","здравствуйте","добрый день","добрый вечер","доброе утро",
  "здарова","доброго дня","доброго вечора",
  // EN
  "hi","hello","hey","good morning","good afternoon","good evening",
  // PL
  "cześć","witam","dzień dobry",
  // CZ
  "ahoj","dobrý den","čau",
  // Общие
  "бот","assistant","manager","менеджер"
]);

function isLikelyNameToken(token = "") {
  const t = lower(token);
  if (!t) return false;
  if (NAME_STOPWORDS.has(t)) return false;
  if (/\d/.test(t)) return false; // цифры в "имени" — мимо
  // слишком общие слова
  if (/(спасибо|thank|thanks|ok|ок|угу|ага)/i.test(t)) return false;
  // длина
  return t.length >= 2 && t.length <= 30;
}

export function detectNameSentence(text = "") {
  // «меня зовут … / my name is … / mam na imię … / jmenuji se …»
  const m = text?.match(
    /\b(меня\s+зовут|i\s*am|my\s+name\s+is|мене\s+звати|mam\s+na\s+imi[eę]|jmenuji\s+se)\s+([A-ZА-Я][A-Za-zА-Яа-яЁёЇїІіЄєҐґ\-']{1,}(?:\s+[A-ZА-Я][A-Za-zА-Яа-яЁёЇїІіЄєҐґ\-']{1,})*)/i
  );
  if (!m) return null;
  const candidate = m[2].trim();
  // проверка каждого слова
  const ok = candidate.split(/\s+/).every(isLikelyNameToken);
  return ok ? candidate : null;
}

export function detectStandaloneName(text = "") {
  const t = norm(text);
  // одиночное слово с заглавной — но не приветствие/стоп-слово
  if (!/^[A-ZА-Я][A-Za-zА-Яа-яЁёЇїІіЄєҐґ\-']{1,29}$/u.test(t)) return null;
  if (!isLikelyNameToken(t)) return null;
  return t;
}

export function detectLeadingName(text = "") {
  const m = norm(text).match(/^([A-ZА-Я][A-Za-zА-Яа-яЁёЇїІіЄєҐґ\-']{1,29})\s*[,—-]/u);
  if (!m) return null;
  const tok = m[1].trim();
  if (!isLikelyNameToken(tok)) return null;
  return tok;
}

export function detectAnyName(text = "") {
  return detectNameSentence(text) || detectStandaloneName(text) || detectLeadingName(text);
}

export function detectPhone(text = "") {
  const m = text?.match(/\+?[0-9][0-9 \-()]{6,}/);
  return m ? m[0].replace(/[^\d+]/g, "") : null;
}

/* ─────────── Пол + обращение ─────────── */
const FEMALE_ENDINGS = [
  "а","я","ia","iia","na","ta","ra","la","sha","scha","ska","eva","ina","yna","ena","onna","anna","alla","ella",
  "maria","olga","irina","natalia","natalya","oksana","tatiana","tetiana","svetlana","svitlana","alena","sofia",
  "zofia","ewa","agnieszka","kasia","katarzyna","aleksandra","veronika","veronica"
];

export function guessGenderByName(nameRaw = "") {
  const first = lower(nameRaw).split(" ")[0];
  if (!first) return null;
  const maleList = ["alexander","oleksandr","aleksandr","andrzej","jan","tomas","marek","piotr","pavel","pawel","michal","mikhail","sergey","serhii","vasyl","viktor","olek","oleg","artur","roman","dmytro","yurii","yuri","ivan"];
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
    case "en": default: return isF ? "Ma'am" : "Sir";
  }
}