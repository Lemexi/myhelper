// /src/classifier.js
// Lightweight NLP utils: normalization, commands, greetings, categories,
// name/phone detection, gender guess, honorifics.
// All code/comments may stay in RU; functional text is language-agnostic.

/* ─────────── Нормализация ─────────── */

export function norm(s = "") {
  return (s || "")
    .replace(/\u00A0/g, " ")      // NBSP → space
    .replace(/\s+/g, " ")         // collapse spaces
    .replace(/[«»]/g, '"')        // unify quotes
    .trim();
}

export function lower(s = "") { return norm(s).toLowerCase(); }

/** Удаляем цитаты и «шапки» переписки из мессенджеров */
export function stripQuoted(raw = "") {
  const lines = (raw || "").split(/\r?\n/);
  const clean = [];
  for (const ln of lines) {
    const l = ln.trim();
    if (!l) continue;
    if (l.startsWith(">")) continue; // quote
    if (/^(from:|replying to|forwarded message)/i.test(l)) continue;
    if (/^(assistant|bot)\b/i.test(l)) continue;
    clean.push(l);
  }
  return clean.join("\n").trim();
}

/* ─────────── Команды ─────────── */

/** «Я бы ответил… / Ответил бы…» */
export function isCmdTeach(raw = "") {
  const t = lower(raw);
  return /(?:^|\s)(?:я\s+бы\s+ответил[ао]?|я\s+ответил[ао]?\s+бы|ответил[ао]?\s+бы(?:\s+я)?)(?:\s|:|$)/i.test(t);
}

export function parseCmdTeach(raw = "") {
  const t = stripQuoted(raw);
  const patterns = [
    /(?:я\s+бы\s+ответил[ао]?|я\s+ответил[ао]?\s+бы|ответил[ао]?\s+бы(?:\s+я)?)\s*:?\s*["“]?([\s\S]+?)["”]?\s*$/i
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m && m[1]) return m[1].trim();
  }
  const cleaned = t.replace(
    /(?:я\s+бы\s+ответил[ао]?|я\s+ответил[ао]?\с+бы|ответил[ао]?\с+бы(?:\s+я)?)\s*:?\s*/i,
    ""
  ).trim();
  return cleaned || null;
}

/** «Переведи …» / «translate (to) …» */
export function isCmdTranslate(raw = "") {
  const t = lower(raw);
  return /\b(переведи|переклади|translate)\b/.test(t);
}

export function parseCmdTranslate(raw = "") {
  const t = stripQuoted(raw);
  const re = /(?:переведи|переклади|translate)(?:\s+(?:на|to)\s+([A-Za-zА-Яа-яёіїєґ\s.-]{1,20}))?\s*:?\s*([\s\S]*?)$/i;
  const m = t.match(re);
  return {
    targetLangWord: (m?.[1] || "").trim().toLowerCase() || null,
    text: (m?.[2] || "").trim()
  };
}

/** Шорткат для «ответь на дорого» */
export function isCmdAnswerExpensive(raw = "") {
  const s = lower(raw);
  return (
    s.includes("ответь на дорого") ||
    s.includes("агент говорит что дорого") ||
    s.includes("too expensive") ||
    s.includes("дорого")
  );
}

/* ─────────── Приветствия ─────────── */

const greetMap = [
  { re: /добрый\s*д(е|ё)нь/i,  out: "Добрый день" },
  { re: /добрый\s*вечер/i,    out: "Добрый вечер" },
  { re: /здравствуй(те)?/i,   out: "Здравствуйте" },
  { re: /привет/i,            out: "Привет" },
  { re: /\bhello\b/i,         out: "Hello" },
  { re: /\bhi\b/i,            out: "Hi" }
];

export function extractGreeting(raw = "") {
  const hit = greetMap.find(g => g.re.test(raw || ""));
  return hit ? hit.out : null;
}

/* ─────────── Классификатор категорий (rule-based фолбэк) ─────────── */

function classifyCategoryRuleBased(text = "") {
  const t = lower(text);
  if (/дорог|expens|price|цена/.test(t)) return "expensive";
  if (/(после\s+визы|after\s+visa)/.test(t)) return "after_visa";
  if (/(контракт|agreement|договор)/.test(t)) return "contract";
  if (/(вакан|demands?|позици|role)/.test(t)) return "demands";
  if (/(виза|visa)/.test(t)) return "visa";
  if (/(работ|job|трудо)/.test(t)) return "work";
  if (/(бизнес|company|firm|LLC|sp\.z o\.o)/.test(t)) return "business";
  if (/(срок|timeline|когда|how long)/.test(t)) return "timeline";
  if (/(процес|как это работает|process)/.test(t)) return "process";
  if (/(документ|docs?|паспорт|permit)/.test(t)) return "docs";
  if (/(привет|hello|hi|здравствуй)/.test(t)) return "greeting";
  if (/(как дела|how are you|чем занимаешься)/.test(t)) return "smalltalk";
  return "general";
}

export const classifyCategory = classifyCategoryRuleBased;

/* ─────────── Имя / телефон ─────────── */

export function detectNameSentence(text = "") {
  // «Меня зовут …» / «My name is …» / «I am …»
  const m =
    text?.match(/\b(меня\s+зовут|my\s+name\s+is|i\s+am|i'm|мене\s+звати|jmenuji\s+se|mam\s+na\s+imi[eę])\s+([^\d,.;:()[\]{}!?]{2,60})/i);
  if (!m) return null;
  // убираем хвостовые маркеры и эмодзи
  return m[2].replace(/["'«»]/g, "").trim();
}

export function detectStandaloneName(text = "") {
  const t = norm(text);
  if (/^[A-ZА-Я][A-Za-zА-Яа-яЁёЇїІіЄєҐґ\-']{1,29}(?:\s+[A-ZА-Я][A-Za-zА-Яа-я\-']{1,29})?$/.test(t)) {
    return t;
  }
  return null;
}

export function detectLeadingName(text = "") {
  const m = norm(text).match(
    /^([A-ZА-Я][A-Za-zА-Яа-яЁёЇїІіЄєҐґ\-']{1,29})\s*[,—-]/i
  );
  return m ? m[1].trim() : null;
}

export function detectAnyName(text = "") {
  return detectNameSentence(text) || detectStandaloneName(text) || detectLeadingName(text);
}

export function detectPhone(text = "") {
  const m = text?.match(/\+?[0-9][0-9 \-()]{6,}/);
  return m ? m[0].replace(/[^\d+]/g, "") : null;
}

/* ─────────── Пол и обращение (опционально) ─────────── */
/** Пробуем угадать пол по явным подсказкам; fallback — male */
export function guessGenderByName(nameRaw = "", context = "") {
  const first = lower(nameRaw).split(/\s+/)[0];
  if (!first) return "male";

  // Явные языковые формы в сообщении
  const ctx = lower(context);
  if (/(я\s+не\s+женщина|i\s+am\s+male|i'm\s+male|i\s+am\s+a\s+man)/.test(ctx)) return "male";
  if (/(я\s+не\s+мужчина|i\s+am\s+female|i'm\s+female|i\s+am\s+a\s+woman)/.test(ctx)) return "female";

  // Списки-индикаторы (минимальные, универсальные)
  const femaleHints = [
    "alina","alena","anna","anita","anastasia","alexandra","maria","mariya","maryam",
    "fatima","aisha","sara","sarah","noor","zainab","olga","irina","natalia","oksana",
    "tatiana","svetlana","sofia","sofiya","katarzyna","agnieszka","ewa","kasia","zofia",
    "veronika","victoria","viktoria"
  ];
  const maleHints = [
    "alexander","aleksandr","oleksandr","andrei","andrey","andriy","mohamed","muhammad",
    "ahmed","ali","hassan","omar","youssef","yusuf","mohammad","jan","tomas","marek",
    "piotr","pawel","michal","pavel","sergey","serhii","viktor","victor"
  ];
  if (femaleHints.includes(first)) return "female";
  if (maleHints.includes(first)) return "male";

  // Окончания (очень грубая эвристика)
  if (/(a|ya|iya|sha|na|ta|ra|la)$/.test(first)) return "female";

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

/* ─────────── Явный экспорт (для ESM) ─────────── */
export default {
  norm,
  lower,
  stripQuoted,
  isCmdTeach,
  parseCmdTeach,
  isCmdTranslate,
  parseCmdTranslate,
  isCmdAnswerExpensive,
  extractGreeting,
  classifyCategory,
  detectAnyName,
  detectPhone,
  detectNameSentence,
  detectStandaloneName,
  detectLeadingName,
  guessGenderByName,
  honorific
};