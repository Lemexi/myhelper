// /src/orchestrator.js

/* ═════════════════ Helpers & constants ═════════════════ */

const NOW = () => Date.now();

const NAME_STOPWORDS = new Set([
  // общие
  "ok","oki","okay","okey","oké","okeyy","oky",
  "ок","окей","ага","да","нет","yes","no","sure","thanks","thankyou","tnx",
  // частые обращение-слова
  "hello","hi","privet","привет","здоров","добрый","здравствуйте","ciao","hola",
  "sir","madam","friend","bro","buddy","dear",
  // страны/города, чтобы не ловить их как имена
  "poland","czech","czechia","serbia","польша","чехия","сербия",
  "warshaw","warsaw","варшава","krakow","вроцлав","wroclaw","prague","прага"
]);

const GREETING_RE = /\b(hi|hello|hey|прив(ет)?|здрав|добро(е|й)\s+(утро|день|вечер))\b/i;

function clean(s){ return String(s||"").trim(); }
function titleCase(w){
  const t = clean(w).toLowerCase();
  if (!t) return t;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/* ═════════════════ Session meta helpers ═════════════════ */

function readSessionMeta(session){
  const raw = (session && (session.meta_json || session.meta || session.orchestrator)) || {};
  return {
    role: raw.role || null,                                 // "candidate" | "agent" | null
    country_interest: Array.isArray(raw.country_interest) ? raw.country_interest : [],
    position_interest: Array.isArray(raw.position_interest) ? raw.position_interest : [],
    headcount: Number.isFinite(raw.headcount) ? raw.headcount : null,

    // поведенческие маркеры
    introduced: !!raw.introduced,                           // сделали «живое» интро
    free_topic_count: Number.isFinite(raw.free_topic_count) ? raw.free_topic_count : 0,
    steer_after: Number.isFinite(raw.steer_after) ? raw.steer_after : 3, // каждые N свободных тем мягко возвращаем к делу
    last_free_topic_ts: raw.last_free_topic_ts || 0,

    asked: raw.asked || {},
    last_question_key: raw.last_question_key || null,
    last_question_ts: raw.last_question_ts || 0,

    consent_overview: !!raw.consent_overview,
    pending_consent: raw.pending_consent || null
  };
}

function setAskedPatch(patch, key){
  patch.asked = { ...(patch.asked||{}) , [key]: true };
  patch.last_question_key = key;
  patch.last_question_ts = NOW();
}
function recentlyAsked(meta, key, cooldownMs=90_000){
  if (!meta.last_question_key || meta.last_question_key !== key) return false;
  return (NOW() - (meta.last_question_ts||0)) < cooldownMs;
}

/* ═════════════════ Name detection (multilingual) ═════════════════ */

export function detectNameSmart(text, knownName = null){
  const raw = String(text||"").trim();
  if (!raw) return null;

  // 1) Явные фразы «меня зовут / my name is / jmenuji se / nazywam się»
  const patterns = [
    /(?:меня\s+зовут|зовут\s+меня|мо[её]\s*имя|это)\s+([^.,\n\r;!]+)/i,
    /(?:my\s+name\s+is|i\s*am|i'm|this\s+is)\s+([^.,\n\r;!]+)/i,
    /(?:mam\s+na\s+imi[eę]|nazywam\s+si[eę]|jestem)\s+([^.,\n\r;!]+)/i,
    /(?:jmenuji\s+se|já\s+jsem)\s+([^.,\n\r;!]+)/i,
    /(?:call\s+me|зовите\s+меня)\s+([^.,\n\r;!]+)/i
  ];
  for (const re of patterns){
    const m = raw.match(re);
    if (m && m[1]){
      const part = m[1].trim().split(/\s+/)[0];
      const naked = part.replace(/[.,!?;:()"'`]/g,"");
      const test = naked.toLowerCase();
      if (NAME_STOPWORDS.has(test)) continue;
      if (/^[A-ZА-ЯŁŚŻŹĆŃÓÉÜÄÖ][a-zа-яёłśżźćńóéüäö'-]{1,19}$/.test(naked)) {
        return { name: titleCase(naked), confidence: 0.95 };
      }
    }
  }

  // 2) Однословный ответ после вопроса об имени — лучше обрабатывать в reply.js,
  //    но подстрахуемся: фильтруем «ок/окей/да/yes»
  if (/^[-–—]?$/.test(raw)) return null;
  const one = raw.split(/\s+/);
  if (one.length === 1){
    const test = one[0].replace(/[.,!?;:()"'`]/g,"").toLowerCase();
    if (!NAME_STOPWORDS.has(test) &&
        /^[A-ZА-ЯŁŚŻŹĆŃÓÉÜÄÖ][a-zа-яёłśżźćńóéüäö'-]{1,19}$/.test(one[0])) {
      return { name: titleCase(one[0]), confidence: 0.7 };
    }
  }

  // 3) Исправления «не X, а Y» / «правильно: Y»
  let corr = raw.match(/не\s+([A-ZА-ЯЁŁŚŻŹĆŃÓÉÜÄÖ][^\s,]+)\s*,?\s*а\s+([A-ZА-ЯЁŁŚŻŹĆŃÓÉÜÄÖ][^\s,]+)/i)
          || raw.match(/правильно\s*[:\-]?\s*([A-ZА-ЯЁŁŚŻŹĆŃÓÉÜÄÖ][^\s,]+)/i)
          || raw.match(/not\s+([A-Z][^\s,]+)\s*,?\s*but\s+([A-Z][^\s,]+)/i);
  if (corr){
    const to = (corr[2] || corr[1] || "").trim();
    const test = to.replace(/[.,!?;:()"'`]/g,"").toLowerCase();
    if (!NAME_STOPWORDS.has(test) &&
        /^[A-ZА-ЯŁŚŻŹĆŃÓÉÜÄÖ][a-zа-яёłśżźćńóéüäö'-]{1,19}$/.test(to)) {
      return { name: titleCase(to), confidence: 0.99, correctedFrom: knownName || undefined, ackNeeded: true };
    }
  }

  return null;
}

/* ═════════════════ Role & intent ═════════════════ */

export function detectRole(text){
  const t = String(text||"").toLowerCase();

  const agentHints = [
    "b2b","partner","partnership","agency","agent","owner","company","our company",
    "recruit","recruiter","hr","consulate","visa",
    "агент","агентство","партнер","партнёр","компания","у меня есть кандидаты","мы отправим кандидатов",
    "визов","кадровое","рекрут"
  ];
  if (agentHints.some(h => t.includes(h))) return "agent";

  const candHints = [
    "i need job","looking for job","for myself","i'm candidate","candidate",
    "я ищу работу","для себя","кандидат","нужна работа","работу в европе","хочу работать"
  ];
  if (candHints.some(h => t.includes(h))) return "candidate";

  return null;
}

function wantsConversationFirst(text){
  const t = String(text||"").toLowerCase();
  return GREETING_RE.test(t) ||
         /(хочу|давайте)\s+(поговорить|пообщаться|обсудить|познакомиться)/.test(t) ||
         /let'?s\s+(talk|chat|discuss|get\s+acquainted)/.test(t) ||
         /(can|may)\s+we\s+(talk|discuss)\b/.test(t);
}

function asksForAnyVacancies(text){
  const t = String(text||"").toLowerCase();
  return /(любые|все)\s+доступн\w*\s+ваканси/i.test(t)
      || /(any|all)\s+available\s+vacanc/i.test(t);
}

function asksForLinkOrCompany(text){
  const t = String(text||"").toLowerCase();
  const link = /(demand|link|ссылка|contract|контракт)/.test(t);
  const company = /(group\s*service|alvi\s*development|best\s*level|fortuna\s*holding|teproprint)/i.test(t);
  const detail = /(salary|график|schedule|жиль|интервью|video\s*interview|appointment)/.test(t);
  return link || company || detail;
}

/* странa / позиции по ключам */
const COUNTRY_ALIASES = {
  PL: ["pl","poland","polska","польша","варшава","krakow","wroclaw","вроцлав"],
  CZ: ["cz","czech","czechia","czech republic","чехия","praha","prague","прага"],
  RS: ["rs","serbia","сербия","belgrade","белград"]
};
function matchCountry(text){
  const t = String(text||"").toLowerCase();
  for (const [code, aliases] of Object.entries(COUNTRY_ALIASES)){
    if (aliases.some(a => t.includes(a))) return code;
  }
  return null;
}

const POSITION_ALIASES = {
  warehouse: ["warehouse","склад","picker","packer","складской","комплектовщик"],
  production: ["production","factory","завод","производство"],
  painter:   ["painter","plasterer","маляр","штукатур","отделочник","finishing"],
  welder:    ["welder","сварщик","welding","mig","mag","tig"],
  helper:    ["helper","помощник","подсобник","labour","labor","рабочий"]
};
function matchPositions(text){
  const t = String(text||"").toLowerCase();
  const res = [];
  for (const [k, aliases] of Object.entries(POSITION_ALIASES)){
    if (aliases.some(a => t.includes(a))) res.push(k);
  }
  return res;
}

/* ═════════════════ Intros & steering text (EN — потом локализуем в reply.js) ═════════════════ */

const INTROS_NO_NAME = [
  "Hello! I’m Viktor Shimansky from RenovoGo (12+ years of legal employment in the EU). May I have your name so I know how to address you?",
  "Hi there — Viktor from RenovoGo. We help with fully legal work arrangements in Czechia & Poland. What’s your name, please?",
  "Good to meet you! I’m Viktor at RenovoGo. To make it personal, may I ask your name?"
];

const INTROS_WITH_NAME = [
  (name) => `Nice to meet you, ${name}. I’m Viktor from RenovoGo — we do legal employment support in Czechia & Poland. How can I help?`,
  (name) => `Great to connect, ${name}. Viktor here (RenovoGo). Tell me what you’re looking for — I’ll guide you.`,
  (name) => `Pleasure, ${name}! Viktor at RenovoGo. What would you like to start with?`
];

const STEER_SNIPPETS = [
  "By the way, when you’re ready, I’ll ask a couple of quick questions to tailor options.",
  "When it suits you, I’ll clarify country/position to pick the best fit.",
  "We can keep chatting — and I’ll circle back to your goals to prepare a shortlist."
];

function pick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }

/* ═════════════════ Main decision engine ═════════════════
 * Возвращает:
 *   { questionEN: string|null, metaPatch: object|null, blockCatalog?: boolean }
 * — questionEN: одна короткая реплика/вопрос (EN), reply.js локализует.
 * — blockCatalog: если true — каталог пока не показываем даже при совпадениях.
 */
export function decideNextStep({ session, text, snapshot }){
  const meta  = readSessionMeta(session);
  const patch = { asked: { ...(meta.asked||{}) } };

  const t = String(text || "");

  // 0) Первое «живое» интро
  const hasName = !!(session && session.user_name && String(session.user_name).trim());
  if (!meta.introduced){
    patch.introduced = true;
    if (!hasName){
      // интро + просьба имени (один CTA)
      return {
        questionEN: pick(INTROS_NO_NAME),
        metaPatch: patch,
        blockCatalog: true
      };
    } else {
      return {
        questionEN: pick(INTROS_WITH_NAME)(session.user_name.trim()),
        metaPatch: patch,
        blockCatalog: true
      };
    }
  }

  // 1) Пользователь хочет «сначала поговорить» — разрешаем свободную тему.
  if (wantsConversationFirst(t)){
    const fc = (meta.free_topic_count || 0) + 1;
    patch.free_topic_count = fc;
    patch.last_free_topic_ts = NOW();

    // мягко steer каждые steer_after свободных темы
    if (fc % (meta.steer_after || 3) === 0){
      return {
        questionEN: pick(STEER_SNIPPETS),
        metaPatch: patch,
        blockCatalog: true
      };
    }
    // просто не мешаем диалогу: ничего не спрашиваем
    return {
      questionEN: null,
      metaPatch: patch,
      blockCatalog: true
    };
  }

  // 2) Роль/страна/позиция — только как мягкая подстройка, без повторов.
  const roleGuess = detectRole(t);
  if (roleGuess && !meta.role) patch.role = roleGuess;

  const c = matchCountry(t);
  if (c && !meta.country_interest.includes(c)){
    patch.country_interest = [...(meta.country_interest||[]), c];
  }
  const poss = matchPositions(t);
  if (poss.length){
    const set = new Set([...(meta.position_interest||[]), ...poss]);
    patch.position_interest = [...set];
  }

  // 3) «Покажи все вакансии» — спросим формат (ссылка vs уточнение), не показываем список сразу
  if (asksForAnyVacancies(t) && !meta.consent_overview && !recentlyAsked(meta, "overview_format")){
    setAskedPatch(patch, "overview_format");
    patch.pending_consent = "overview";
    return {
      questionEN: "I can share one link with all open roles, or we can narrow by country/position first. What’s better for you?",
      metaPatch: patch,
      blockCatalog: true
    };
  }

  // 4) Если пользователь НЕ просит каталог явно — не сыпем список и не давим вопросами.
  const explicitDetails = asksForLinkOrCompany(t);
  if (!meta.consent_overview && !explicitDetails){
    // если роль ещё не ясна — мягко (и не чаще, чем раз в 90 сек)
    if (!meta.role && !patch.role && !recentlyAsked(meta, "role")){
      setAskedPatch(patch, "role");
      return {
        questionEN: "Just to guide you properly: are you reaching out as an individual candidate, or as an agency/company?",
        metaPatch: patch,
        blockCatalog: true
      };
    }

    // страна
    const countries = patch.country_interest || meta.country_interest || [];
    if (!countries.length && !recentlyAsked(meta, "country")){
      setAskedPatch(patch, "country");
      return {
        questionEN: "Which country would you like to start with — Czech Republic or Poland? (Serbia is possible too.)",
        metaPatch: patch,
        blockCatalog: true
      };
    }

    // позиция
    const positions = patch.position_interest || meta.position_interest || [];
    if (!positions.length && !recentlyAsked(meta, "position")){
      setAskedPatch(patch, "position");
      return {
        questionEN: "What kind of work fits best: warehouse/production, construction/finishing (e.g., painter–plasterer), or something else?",
        metaPatch: patch,
        blockCatalog: true
      };
    }

    // если роль = агент — спросим количество кандидатов (для рассчёта), но без повторов
    const finalRole = patch.role || meta.role;
    if (finalRole === "agent" && !meta.headcount && !patch.headcount && !recentlyAsked(meta, "headcount")){
      setAskedPatch(patch, "headcount");
      return {
        questionEN: "How many candidates do you plan to submit initially? I’ll show pricing per candidate and for your batch.",
        metaPatch: patch,
        blockCatalog: true
      };
    }
  }

  // 5) Ничего специального — не мешаем диалогу, каталог не блокируем если пользователь сам запросил.
  return {
    questionEN: null,
    metaPatch: Object.keys(patch).length ? patch : null,
    blockCatalog: !explicitDetails && !meta.consent_overview
  };
}