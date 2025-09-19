// /src/classifier.js

// ─────────────────────────────────────────────────────────────
// Нормализация и чистка цитат/префиксов
// ─────────────────────────────────────────────────────────────
export function norm(s = "") {
  // аккуратно приводим пробелы и кавычки
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
    if (l.startsWith(">")) continue; // цитаты
    if (/^(assistant|bot)\b/i.test(l)) continue; // подписи
    if (/renovogo\.com/i.test(l)) continue;
    if (/^(from:|replying to)/i.test(l)) continue;
    clean.push(l);
  }
  return clean.join("\n").trim();
}

// ─────────────────────────────────────────────────────────────
// Триггеры-команды
// ─────────────────────────────────────────────────────────────

// «Я бы ответил/а …» — ловим варианты порядка слов и женскую форму
export function isCmdTeach(raw = "") {
  const t = lower(raw);
  return /(?:^|\s)(?:я\s+бы\s+ответил[ао]?|я\s+ответил[ао]?\s+бы|ответил[ао]?\s+бы(?:\s+я)?)(?:\s|:|$)/i.test(t);
}

export function parseCmdTeach(raw = "") {
  const t = stripQuoted(raw);

  // несколько шаблонов, чтобы поймать разные формулировки
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

  // fallback: срезаем ключевые слова, если они есть
  const cleaned = t.replace(
    /(?:я\s+бы\s+ответил[ао]?|я\s+ответил[ао]?\s+бы|ответил[ао]?\s+бы(?:\s+я)?)\s*:?\s*/i,
    ""
  ).trim();
  return cleaned && cleaned !== t ? cleaned : null;
}

// Перевод: поддержим «переведи», «переклади», «translate (to …)»
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

// Быстрый триггер готового ответа на «дорого»
export function isCmdAnswerExpensive(raw = "") {
  const s = lower(raw);
  return s.includes("ответь на дорого") || s.includes("агент говорит что дорого");
}

// Общий триггер вида «ответь на …»
export function isCmdAnswerGeneric(raw = "") {
  return /^ответь\s+на\s+/i.test(stripQuoted(raw));
}

// ─────────────────────────────────────────────────────────────
// Приветствия
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
// Классификатор (rule-based фолбэк для роутера)
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

  // явные категории домена
  if (/(виза|visa|посольств|штамп|подач[аи]|приглашени[ея])/.test(t)) return "visa";
  if (/(работа|job|ваканси|вакансии|найти\s+работу|трудоустройств)/.test(t)) return "work";
  if (/(бизнес|company|организаци(я|и)\s+бизнес|открыть\s+фирм|sp\.? z o\.o|s\.r\.o)/.test(t)) return "business";
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
// Имя / телефон (детект)
// ─────────────────────────────────────────────────────────────
export function detectNameSentence(text = "") {
  // «меня зовут …» / «my name is …» / «i am …» и аналоги
  const m = (text || "").match(
    /\b(меня\s+зовут|i\s*am|my\s+name\s+is|мене\s+звати|mam\s+na\s+imie|jmenuji\s+se)\s+([A-ZА-Я][A-Za-zА-Яа-яЁёЇїІіЄєҐґ\-']{1,}(?:\s+[A-ZА-Я][A-Za-zА-Яа-яЁёЇїІіЄєҐґ\-']{1,})?)/i
  );
  return m ? m[2].trim() : null;
}

export function detectStandaloneName(text = "") {
  const t = norm(text);
  if (/^[A-ZА-Я][A-Za-zА-Яа-яЁёЇїІіЄєҐґ\-']{1,29}$/.test(t)) return t;
  return null;
}

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
// Пол + обращение
// ─────────────────────────────────────────────────────────────
const FEMALE_ENDINGS = [
  "а","я","ia","iia","na","ta","ra","la","sha","scha","ska","eva","ina","yna","ena",
  "onna","anna","alla","ella","maria","olga","irina","natalia","natalya","oksana",
  "tatiana","tetiana","svetlana","svitlana","alena","sofia","zofia","ewa",
  "agnieszka","kasia","katarzyna","aleksandra","veronika","veronica"
];

export function guessGenderByName(nameRaw = "") {
  const first = lower(nameRaw).split(" ")[0];
  if (!first) return null;
  const maleList = [
    "alexander","oleksandr","aleksandr","andrzej","jan","tomas","marek","piotr",
    "pavel","pawel","michal","mikhail","sergey","serhii","vasyl","viktor","victor"
  ];
  if (maleList.includes(first)) return "male";
  if (FEMALE_ENDINGS.some(s => first.endsWith(s))) return "female";
  // по умолчанию мягко считаем male (вежливое обращение нейтрально)
  return "male";
}

export function honorific(lang = "ru", gender = "male") {
  const isF = gender === "female";
  switch ((lang || "ru").toLowerCase()) {
    case "ru": return isF ? "Мэм" : "Сэр";
    case "uk": return isF ? "Пані" : "Пане";
    case "pl": return isF ? "Pani" : "Panie";
    case "cs":
    case "cz": return isF ? "Paní" : "Pane";
    case "en": default: return isF ? "Ma'am" : "Sir";
  }
}