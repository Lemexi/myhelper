// /src/orchestrator.js

/* ───────────────── Utils ───────────────── */

const NAME_STOPWORDS = new Set([
  // города/страны/общие слова, которые часто ловятся как "имя"
  "польша","чехия","сербия","poland","czech","czechia","serbia",
  "варшава","прага","вроцлав","krakow","wroclaw","prague",
  "hello","привет","sir","madam","friend","bro","man","woman"
]);

function clean(str) { return String(str || "").trim(); }
function isLikelyName(tok) {
  const t = clean(tok);
  if (!t) return false;
  if (t.length < 2 || t.length > 20) return false;
  const naked = t.replace(/[.,!?;:()"'`]/g, "");
  if (!naked) return false;
  // первая буква заглавная или все caps (некоторые пишут ALEX)
  const isCap = /^[A-ZА-ЯŁŚŻŹĆŃÓÉÜÄÖ][a-zа-яёłśżźćńóéüäö'-]*$/.test(naked) ||
                /^[A-ZА-ЯŁŚŻŹĆŃÓÉÜÄÖ]{2,20}$/.test(naked);
  if (!isCap) return false;
  if (NAME_STOPWORDS.has(naked.toLowerCase())) return false;
  return true;
}

/* ───────────────── Name detection ───────────────── */
/**
 * Возвращает:
 * { name, confidence (0..1), correctedFrom?, ackNeeded? }
 * ackNeeded=true, если пользователь ЯВНО исправил предыдущее имя.
 */
export function detectNameSmart(text, knownName = null) {
  const raw = String(text || "");
  const low = raw.toLowerCase();

  // 1) Явные паттерны "меня зовут/ my name is / mam na imię / jmenuji se"
  const patterns = [
    /(?:меня\s+зовут|зовут\s+меня|мое\s+имя|моё\s+имя|я\s+—|я\s*-|это\s+)([^.,\n\r;!]+)/i,
    /(?:my\s+name\s+is|i\s*am|i'm|this\s+is)\s+([^.,\n\r;!]+)/i,
    /(?:mam\s+na\s+imi[eę]|nazywam\s+si[eę]|jestem)\s+([^.,\n\r;!]+)/i,
    /(?:jmenuji\s+se|já\s+jsem)\s+([^.,\n\r;!]+)/i,
    /(?:call\s+me|зовите\s+меня)\s+([^.,\n\r;!]+)/i
  ];

  for (const re of patterns) {
    const m = raw.match(re);
    if (m && m[1]) {
      // возьмём первый токен (или два, если это имя+фамилия и оба похожи на имена)
      const parts = m[1].trim().split(/\s+/).slice(0, 2);
      const candidates = parts.filter(isLikelyName);
      if (candidates.length) {
        const nm = candidates.join(" ");
        return { name: nm, confidence: 0.95 };
      }
    }
  }

  // 2) Простая форма "я Александр" / "i am Alex" без явной метки
  const loose = raw.match(/\b(?:я|i\s*am|i'm|jestem|já\s+jsem)\s+([A-ZА-ЯŁŚŻŹĆŃÓÉÜÄÖ][^\s,.!?;:]+)/i);
  if (loose && isLikelyName(loose[1])) {
    return { name: loose[1].trim(), confidence: 0.6 };
  }

  // 3) Исправление имени: "не Олег, а Александр" / "not John, but Alex" / "правильно: Александр"
  // Русские варианты
  let corr = raw.match(/не\s+([A-ZА-ЯЁŁŚŻŹĆŃÓÉÜÄÖ][^\s,]+)\s*,?\s*а\s+([A-ZА-ЯЁŁŚŻŹĆŃÓÉÜÄÖ][^\s,]+)/i);
  if (!corr) corr = raw.match(/правильно\s*[:\-]?\s*([A-ZА-ЯЁŁŚŻŹĆŃÓÉÜÄÖ][^\s,]+)/i);
  // Английские варианты
  if (!corr) corr = raw.match(/not\s+([A-Z][^\s,]+)\s*,?\s*but\s+([A-Z][^\s,]+)/i);
  if (corr) {
    const from = corr[1] && isLikelyName(corr[1]) ? corr[1].trim() : (knownName || null);
    const to   = (corr[2] || corr[1] || "").trim();
    if (isLikelyName(to)) {
      return { name: to, confidence: 0.99, correctedFrom: from || undefined, ackNeeded: true };
    }
  }

  // 4) Ничего не нашли
  return null;
}

/* ───────────────── Role detection ───────────────── */
/** Возвращает "candidate" | "agent" | null */
export function detectRole(text) {
  const t = String(text || "").toLowerCase();

  // агент/партнёр
  const agentHints = [
    "agent","agency","agency owner","owner","partner","partnership","company",
    "recruit","recruiter","hr","consultant","consulate","visa",
    "у меня есть кандидаты","могу отправить кандидатов","я агент","агентство","партнер","компания",
    "кадровое","рекрут","визов","консул"
  ];
  for (const h of agentHints) if (t.includes(h)) return "agent";

  // кандидат
  const candHints = [
    "i need job","looking for job","for myself","i'm candidate",
    "я ищу работу","для себя","кандидат","нужна работа"
  ];
  for (const h of candHints) if (t.includes(h)) return "candidate";

  // по умолчанию неизвестно
  return null;
}

/* ───────────────── Orchestrator (next question) ───────────────── */

// Страны и алиасы (ENG выводим в вопросах)
const COUNTRY_ALIASES = {
  PL: ["pl","poland","польша","польский","pl/","pl.","polska","варшава","krakow","wroclaw","вроцлав"],
  CZ: ["cz","czech","czechia","czech republic","чехия","чешский","praha","prague","прага"],
  RS: ["rs","serbia","сербия","belgrade","белград"]
};
function matchCountry(text) {
  const t = String(text || "").toLowerCase();
  for (const [code, aliases] of Object.entries(COUNTRY_ALIASES)) {
    if (aliases.some(a => t.includes(a))) return code;
  }
  return null;
}

// Позиции (грубо)
const POSITION_ALIASES = {
  warehouse: ["warehouse","склад","складской","picker","packer"],
  production: ["production","factory","завод","производство"],
  painter: ["painter","plasterer","маляр","штукатур","отделочник"],
  welder: ["welder","сварщик"],
  helper: ["helper","помощник","подсобник","labour","labor"]
};
function matchPositions(text) {
  const t = String(text || "").toLowerCase();
  const res = [];
  for (const [key, aliases] of Object.entries(POSITION_ALIASES)) {
    if (aliases.some(a => t.includes(a))) res.push(key);
  }
  return res;
}

// Явный запрос на ссылку (Demand/Contract) или конкретику компании
function asksForLinkOrDetails(text) {
  const t = String(text || "").toLowerCase();
  const link = /demand|link|ссылка|contract|контракт/.test(t);
  const askDetails = /graphic|schedule|salary|жиль|интервью|оплата|услов|ваканси|есть ли/i.test(t);
  return link || askDetails;
}
function mentionsCompany(text) {
  const t = String(text || "").toLowerCase();
  // можно расширить списком компаний
  return /group\s*service|alvi\s*development|best\s*level|fortuna\s*holding|teproprint/i.test(t);
}

// Берём "мета-контейнер" из session (под разные форматы)
function readSessionMeta(session) {
  const m = (session && (session.meta_json || session.meta || session.orchestrator || {})) || {};
  return {
    role: m.role || null,
    country_interest: Array.isArray(m.country_interest) ? m.country_interest : [],
    position_interest: Array.isArray(m.position_interest) ? m.position_interest : [],
    headcount: Number.isFinite(m.headcount) ? m.headcount : null,
    asked: m.asked || {}
  };
}

/**
 * Решает, какой один вопрос задать дальше, и стоит ли блокировать показ каталога.
 * Возвращает:
 *  { questionEN: string|null, metaPatch: object|null, blockCatalog?: boolean }
 */
export function decideNextStep({ session, text, snapshot }) {
  const meta = readSessionMeta(session);
  const patch = { asked: { ...(meta.asked || {}) } };

  // Попытка определить роль по текущему сообщению
  const roleGuess = detectRole(text);
  if (roleGuess && !meta.role) {
    patch.role = roleGuess;
  }

  // Попытка определить страну/позицию из текста
  const c = matchCountry(text);
  if (c && !meta.country_interest.includes(c)) {
    patch.country_interest = [...(meta.country_interest || []), c];
  }
  const poss = matchPositions(text);
  if (poss.length) {
    const set = new Set([...(meta.position_interest || []), ...poss]);
    patch.position_interest = [...set];
  }

  // Если пользователь сразу спрашивает ссылку/детали или называет компанию —
  // не блокируем каталог, даже если ещё не всё собрано.
  const explicitDetails = asksForLinkOrDetails(text) || mentionsCompany(text);
  if (explicitDetails) {
    return { questionEN: null, metaPatch: Object.keys(patch).length ? patch : null, blockCatalog: false };
  }

  // Чекпоинты в порядке приоритета (задаём только один вопрос):
  // 1) Роль
  if (!meta.role && !patch.role) {
    patch.asked.role = true;
    return {
      questionEN: "Just to guide you properly: are you reaching out as an individual candidate or as an agency/company?",
      metaPatch: patch,
      blockCatalog: true
    };
  }

  // 2) Страна
  const countries = (patch.country_interest || meta.country_interest || []);
  if (!countries.length) {
    patch.asked.country = true;
    return {
      questionEN: "Which country would you like to consider first — Czech Republic or Poland? (Serbia is possible too.)",
      metaPatch: patch,
      blockCatalog: true
    };
  }

  // 3) Позиция
  const positions = (patch.position_interest || meta.position_interest || []);
  if (!positions.length) {
    patch.asked.position = true;
    return {
      questionEN: "What kind of work fits you best: warehouse/production, construction/finishing (e.g., painter-plasterer), or something else?",
      metaPatch: patch,
      blockCatalog: false // можно уже коротко отвечать по стране; но длинный список всё ещё не шлём
    };
  }

  // 4) Если роль = агент — количество кандидатов (для корректных расчётов)
  const role = patch.role || meta.role;
  if (role === "agent" && !meta.headcount && !patch.headcount) {
    patch.asked.headcount = true;
    return {
      questionEN: "How many candidates do you plan to submit initially? I’ll show pricing per candidate and for your batch.",
      metaPatch: patch,
      blockCatalog: false
    };
  }

  // Всё базовое есть — не задаём вопрос; каталог не блокируем
  return { questionEN: null, metaPatch: Object.keys(patch).length ? patch : null, blockCatalog: false };
}