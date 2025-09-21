// /src/classifier.js

/* ─────────── Нормализация ─────────── */
export function norm(s = "") {
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
    if (/^assistant\b|renovogo\.com|^bot\b|^from:|^replying to/i.test(l)) continue; // шапки/системные
    clean.push(l);
  }
  return clean.join("\n").trim();
}

/* ─────────── Триггеры-команды ─────────── */

// «Я бы ответил/а …»
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

// Перевод
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

// «Ответь на дорого»
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

/* ─────────── Классификатор (эвристика) ───────────
   ВАЖНО: категории согласованы с reply.js:
   - каталог: "vacancies", "jobs", "catalog", "positions", "countries_overview", "vacancy_detail"
   - b2b: "b2b"
   - прочее: "expensive", "after_visa", "contract", "payments", "visa", "guarantee", "general"
*/
function hasAny(t, arr) { return arr.some(w => t.includes(w)); }

export async function classifyCategoryRuleBased(text = "") {
  const t = lower(text);

  // 1) Каталог/вакансии/страны → guard в reply.js
  const vacancyKeys = [
    "ваканс", "позици", "должност", "каталог", "список", "открыт", "что у вас есть",
    "доступные", "направлени", "страны", "какие есть", "что доступно",
    "available positions", "what positions", "what do you have", "open countries", "countries available",
    "польша", "чехи", "серби", "литв", "латв", "эстони", "estoni", "germany", "герман", "словаки", "romani", "румын"
  ];
  if (hasAny(t, vacancyKeys)) {
    // Уточнённые подтипы (не обязательно, но может помочь аналитике)
    if (/\b(детал|detail|описан[ие]|услови[яе])\b/.test(t)) return "vacancy_detail";
    if (/\b(страны|countries|направлени[яе])\b/.test(t)) return "countries_overview";
    return "vacancies";
  }

  // 2) B2B/партнёрство
  const b2bKeys = [
    "b2b","б2б","партнер","партнёр","сотрудничеств","агентств","visa agent","визов","рекрутингов",
    "поставлять кандидатов","сколько кандидатов","сколько людей сможете","мощность","отбор кандидатов","поставки"
  ];
  if (hasAny(t, b2bKeys)) return "b2b";

  // 3) Платежи/инвойс
  const paymentKeys = ["оплат", "платеж", "оплата", "счёт", "инвойс", "invoice", "крипт", "crypto", "usdt"];
  if (hasAny(t, paymentKeys)) return "payments";

  // 4) Визы/гарантии
  if (t.includes("после виз") || t.includes("after visa")) return "after_visa";
  if (t.includes("виза") || t.includes("visa")) return "visa";
  if (t.includes("гаранти") || t.includes("guarantee")) return "guarantee";

  // 5) Контракты/договоры
  const contractKeys = ["контракт", "договор", "agreement", "оферта","coop","cooperation"];
  if (hasAny(t, contractKeys)) return "contract";

  // 6) Возражение «дорого»
  if (t.includes("дорог") || /\b(expensive|too\s+much|too\s+high)\b/.test(t)) return "expensive";

  // 7) Перевод/обучение (на всякий)
  if (isCmdTranslate(text)) return "translate";
  if (isCmdTeach(text)) return "teach";

  return "general";
}
export const classifyCategory = classifyCategoryRuleBased;

/* ─────────── Имя / телефон ─────────── */

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
  if (/\d/.test(t)) return false;
  if (/(спасибо|thank|thanks|ok|ок|угу|ага)/i.test(t)) return false;
  return t.length >= 2 && t.length <= 30;
}

export function detectNameSentence(text = "") {
  const m = text?.match(
    /\b(меня\s+зовут|i\s*am|my\s+name\s+is|мене\s+звати|mam\s+na\s+imi[eę]|jmenuji\s+se)\s+([A-ZА-Я][A-Za-zА-Яа-яЁёЇїІіЄєҐґ\-']{1,}(?:\s+[A-ZА-Я][A-Za-zА-Яа-яЁёЇїІіЄєҐґ\-']{1,})*)/i
  );
  if (!m) return null;
  const candidate = m[2].trim();
  const ok = candidate.split(/\s+/).every(isLikelyNameToken);
  return ok ? candidate : null;
}

export function detectStandaloneName(text = "") {
  const t = norm(text);
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
