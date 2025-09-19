// /src/classifier.js

// ─────────────────────────────────────────────────────────────
// Normalize & quote cleaning
// ─────────────────────────────────────────────────────────────
export function norm(s = "") {
  return (s || "")
    .replace(/\s+/g, " ")
    .replace(/[«»”“„"'\u00A0]/g, '"')
    .trim();
}

export function lower(s = "") {
  return norm(s).toLowerCase();
}

export function stripQuoted(raw = "") {
  const lines = (raw || "").split(/\r?\n/);
  const clean = [];
  for (const ln of lines) {
    const l = ln.trim();
    if (!l) continue;
    if (l.startsWith(">")) continue; // quoted lines
    if (/^(assistant|bot)\b/i.test(l)) continue;
    if (/renovogo\.com/i.test(l)) continue;
    if (/^(from:|replying to)/i.test(l)) continue;
    clean.push(l);
  }
  return clean.join("\n").trim();
}

// ─────────────────────────────────────────────────────────────
// Command triggers
// ─────────────────────────────────────────────────────────────

// «Я бы ответил(а) …» (варианты порядка слов + женская форма)
export function isCmdTeach(raw = "") {
  const t = lower(raw);
  return /(?:^|\s)(?:я\s+бы\s+ответил[ао]?|я\s+ответил[ао]?\s+бы|ответил[ао]?\s+бы(?:\s+я)?)(?:\s|:|$)/i.test(t);
}

export function parseCmdTeach(raw = "") {
  const t = stripQuoted(raw);
  const patterns = [
    /(?:я\s+бы\s+ответил[ао]?|я\s+ответил[ао]?\s+бы|ответил[ао]?\s+бы(?:\s+я)?)\s*:?\s*["“”']?([\s\S]+?)["“”']?$/i,
    /^(?:ответил[ао]?\s+бы)\s*:?\s*["“”']?([\s\S]+?)["“”']?$/i
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m && m[1]) {
      const result = m[1].trim();
      if (result) return result;
    }
  }
  const cleaned = t.replace(
    /(?:я\s+бы\s+ответил[ао]?|я\s+ответил[ао]?\s+бы|ответил[ао]?\s+бы(?:\s+я)?)\s*:?\s*/i,
    ""
  ).trim();
  return cleaned && cleaned !== t ? cleaned : null;
}

// Перевод: «переведи», «переклади», «translate (to …)»
export function isCmdTranslate(raw = "") {
  const t = lower(raw);
  return /\b(переведи|переклади|translate)\b/.test(t);
}

export function parseCmdTranslate(raw = "") {
  const t = stripQuoted(raw);
  const re = /(?:переведи|переклади|translate)(?:\s+(?:на|to)\s+([A-Za-zА-Яа-яёіїєґ.\s]{1,20}))?\s*:?\s*([\s\S]*?)$/i;
  const m = t.match(re);
  return {
    targetLangWord: m && m[1] ? m[1].trim().toLowerCase() : null,
    text: m && m[2] ? m[2].trim() : ""
  };
}

// Быстрый триггер «ответь на дорого»
export function isCmdAnswerExpensive(raw = "") {
  const s = lower(raw);
  return s.includes("ответь на дорого") || s.includes("агент говорит что дорого");
}

// Общий триггер «ответь на …»
export function isCmdAnswerGeneric(raw = "") {
  return /^ответь\s+на\s+/i.test(stripQuoted(raw));
}

// ─────────────────────────────────────────────────────────────
/* Greetings */
// ─────────────────────────────────────────────────────────────
const greetMap = [
  { re: /добрый\s*д(е|ё)нь/i, ru: "Добрый день" },
  { re: /добрый\s*вечер/i,   ru: "Добрый вечер" },
  { re: /здравствуй(те)?/i,  ru: "Здравствуйте" },
  { re: /привет/i,           ru: "Привет" },
  { re: /\bhello\b/i,        ru: "Hello" },
  { re: /\bhi\b/i,           ru: "Hi" }
];

export function extractGreeting(raw = "") {
  const hit = greetMap.find(g => g.re.test(raw || ""));
  return hit ? hit.ru : null;
}

// ─────────────────────────────────────────────────────────────
/* Category classifier (rule-based fallback) */
// ─────────────────────────────────────────────────────────────
export async function classifyCategoryRuleBased(text = "") {
  const t = lower(text);

  // greeting / smalltalk
  if (/\b(hi|hello)\b/.test(t) || /(привет|здравствуй|добрый\s*(день|вечер))/.test(t)) {
    return "greeting";
  }
  if (/(как\s+дела|how are you|что\s+нового)/.test(t)) {
    return "smalltalk";
  }

  // domain intents
  if (/(виза|visa|посольств|штамп|подач[аи]|приглашени[ея])/.test(t)) return "visa";
  if (/(работа|job|ваканси|вакансии|найти\s+работу|трудоустройств)/.test(t)) return "work";
  if (/(бизнес|company|организаци(я|и)\s+бизнес|открыть\s+фирм|sp\.?\s*z\s*o\.?o|s\.?\s*r\.?\s*o)/.test(t)) return "business";
  if (/(документ|docs?|пакет\s+документов|список\s+документов)/.test(t)) return "docs";
  if (/(сколько|цена|стоимост|price|rate|ставк[аи]|оплата|сколько\s+стоит)/.test(t)) return "price";
  if (/(срок|timeline|когда|сколько\s+времени|дедлайн|deadline)/.test(t)) return "timeline";
  if (/(процес|process|этап|как\s+это\s+работает|как\s+делаем)/.test(t)) return "process";
  if (/(дорог|too\s+expensive|expensive)/.test(t)) return "expensive";
  if (/(контракт|agreement|offer|догов)/.test(t)) return "contract";
  if (/(demands?|ваканси|требовани[яе]|позици[яи]|роль)/.test(t)) return "demands";

  return "general";
}

export const classifyCategory = classifyCategoryRuleBased;

// ─────────────────────────────────────────────────────────────
/* Name / phone detection */
// ─────────────────────────────────────────────────────────────

// «меня зовут … / my name is … / i’m … / jmenuji se … / mam na imię …»
export function detectNameSentence(text = "") {
  const m = (text || "").match(
    /\b(меня\s+зовут|i\s*am|i['’]m|my\s+name\s+is|мене\s+звати|mam\s+na\s+imie|jmenuji\s+se)\s+([A-ZА-Я][A-Za-zА-Яа-яЁёЇїІіЄєҐґ\-']{1,}(?:\s+[A-ZА-Я][A-Za-zА-Яа-яЁёЇїІіЄєҐґ\-']{1,})?)/i
  );
  return m ? m[2].trim() : null;
}

// Одно слово — вероятное имя
export function detectStandaloneName(text = "") {
  const t = norm(text);
  if (/^[A-ZА-Я][A-Za-zА-Яа-яЁёЇїІіЄєҐґ\-']{1,29}$/.test(t)) return t;
  return null;
}

// Имя в начале строки, затем запятая/тире
export function detectLeadingName(text = "") {
  const m = norm(text).match(/^([A-ZА-Я][A-Za-zА-Яа-яЁёЇїІіЄєҐґ\-']{1,29})\s*[,—-]/);
  return m ? m[1].trim() : null;
}

export function detectAnyName(text = "") {
  return detectNameSentence(text) || detectStandaloneName(text) || detectLeadingName(text);
}

export function detectPhone(text = "") {
  const m = (text || "").match(/\+?[0-9][0-9 \-()]{6,}/);
  return m ? m[0].replace(/[^\d+]/g, "") : null;
}

// ─────────────────────────────────────────────────────────────
/* Gender + honorific (safe, multi-region) */
// ─────────────────────────────────────────────────────────────

// Явные подсказки в тексте/подписях
const FEMALE_HINTS = [
  /\b(ms|mrs|miss|madam|ma'am)\b/i,
  /\bгоспожа\b/i,
  /\bпані\b/i,
  /\bpani\b/i,
  /\bpaní\b/i,
  /\bя\s+женщин[аы]\b/i,
  /\bя\s+девушк[а-и]\b/i,
  /\bi\s+am\s+(a\s+)?(woman|female)\b/i
];

const MALE_HINTS = [
  /\bmr\b/i,
  /\bгосподин\b/i,
  /\bпан\b/i,
  /\bя\s+мужчин[аы]\b/i,
  /\bi\s+am\s+(a\s+)?(man|male)\b/i
];

// Исключения для славянских «-а/-я», которые часто мужские
const SLAVIC_MALE_EXCEPTIONS = new Set([
  "никита","nikita","илья","ilya","ilia","iliah","костя","kostya","женя","zhenya",
  "валера","valera","саша","sasha","паша","pasha","стаса","stasa" // на всякий
]);

/**
 * Определяем пол:
 * 1) Сначала явные подсказки в тексте (Mrs/Mr/Госпожа/Господин…).
 * 2) Если нет — мягкая эвристика для славянских имён:
 *    - Оканчивается на -а/-я ⇒ вероятно female (кроме известных исключений).
 *    - Иначе пола не знаем.
 * Возвращаем { gender: 'male'|'female'|null, confidence: 0..1, reason }.
 */
export function guessGenderByName(nameRaw = "", context = "") {
  const joined = `${nameRaw || ""} ${context || ""}`.trim();

  if (FEMALE_HINTS.some(re => re.test(joined))) {
    return { gender: "female", confidence: 0.95, reason: "explicit_hint" };
    }
  if (MALE_HINTS.some(re => re.test(joined))) {
    return { gender: "male", confidence: 0.95, reason: "explicit_hint" };
  }

  // Мягкая славянская эвристика: Александра vs Александр и т.п.
  const name = (nameRaw || "").trim();
  if (name) {
    const first = lower(name).split(/\s+/)[0]; // берем первое слово
    const endsA = /[аa]$/.test(first);        // кир/лат -а
    const endsYa = /[я]$/.test(first);        // кир -я

    if ((endsA || endsYa) && !SLAVIC_MALE_EXCEPTIONS.has(first)) {
      return { gender: "female", confidence: 0.6, reason: "slavic_suffix" };
    }

    // Если имя явно мужское (Александр vs Александра) по точному совпадению
    const MALE_EXACT = new Set(["александр","alexander","андрzej","jan","tomas","marek","piotr","pavel","pawel","michal","mikhail","sergey","serhii","vasyl","viktor","victor"]);
    if (MALE_EXACT.has(first)) {
      return { gender: "male", confidence: 0.7, reason: "male_exact_list" };
    }

    const FEMALE_EXACT = new Set(["александра","alexandra"]);
    if (FEMALE_EXACT.has(first)) {
      return { gender: "female", confidence: 0.7, reason: "female_exact_list" };
    }
  }

  // по умолчанию — нейтрально
  return { gender: null, confidence: 0.0, reason: "neutral_default" };
}

/**
 * Вежливое обращение:
 * - если gender неизвестен — нейтральное приветствие (рекомендуется).
 * - если задан — уважаемые формы на нужном языке.
 */
export function honorific(lang = "ru", gender = null) {
  const L = (lang || "ru").toLowerCase();

  const NEUTRAL = {
    ru: "Здравствуйте",
    uk: "Доброго дня",
    pl: "Dzień dobry",
    cs: "Dobrý den",
    cz: "Dobrý den",
    en: "Hello"
  };

  if (!gender) return NEUTRAL[L] || NEUTRAL.en;

  if (gender === "female") {
    switch (L) {
      case "ru": return "Госпожа";
      case "uk": return "Пані";
      case "pl": return "Pani";
      case "cs":
      case "cz": return "Paní";
      case "en": default: return "Ma'am";
    }
  }

  switch (L) {
    case "ru": return "Господин";
    case "uk": return "Пане";
    case "pl": return "Panie";
    case "cs":
    case "cz": return "Pane";
    case "en": default: return "Sir";
  }
}