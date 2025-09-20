// /src/orchestrator.js

/* ───────────────── Small helpers ───────────────── */

const NOW = () => Date.now();

const NAME_STOPWORDS = new Set([
  "польша","чехия","сербия","poland","czech","czechia","serbia",
  "варшава","прага","вроцлав","krakow","wroclaw","prague",
  "hello","привет","sir","madam","friend","bro","man","woman"
]);

function clean(s){ return String(s||"").trim(); }
function isLikelyName(tok){
  const t = clean(tok);
  if (!t || t.length < 2 || t.length > 20) return false;
  const naked = t.replace(/[.,!?;:()"'`]/g,"");
  const isCap =
    /^[A-ZА-ЯŁŚŻŹĆŃÓÉÜÄÖ][a-zа-яёłśżźćńóéüäö'-]*$/.test(naked) ||
    /^[A-ZА-ЯŁŚŻŹĆŃÓÉÜÄÖ]{2,20}$/.test(naked);
  if (!isCap) return false;
  if (NAME_STOPWORDS.has(naked.toLowerCase())) return false;
  return true;
}

function readSessionMeta(session){
  const m = (session && (session.meta_json || session.meta || session.orchestrator || {})) || {};
  return {
    role: m.role || null,
    country_interest: Array.isArray(m.country_interest) ? m.country_interest : [],
    position_interest: Array.isArray(m.position_interest) ? m.position_interest : [],
    headcount: Number.isFinite(m.headcount) ? m.headcount : null,
    asked: m.asked || {},
    last_question_key: m.last_question_key || null,
    last_question_ts: m.last_question_ts || 0,
    consent_overview: !!m.consent_overview,
    pending_consent: m.pending_consent || null
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

/* ───────────────── Name detection ───────────────── */

export function detectNameSmart(text, knownName = null){
  const raw = String(text||"");

  const patterns = [
    /(?:меня\s+зовут|зовут\s+меня|мое\s*имя|моё\s*имя|я\s*[—-]|это\s+)([^.,\n\r;!]+)/i,
    /(?:my\s+name\s+is|i\s*am|i'm|this\s+is)\s+([^.,\n\r;!]+)/i,
    /(?:mam\s+na\s+imi[eę]|nazywam\s+si[eę]|jestem)\s+([^.,\n\r;!]+)/i,
    /(?:jmenuji\s+se|já\s+jsem)\s+([^.,\n\r;!]+)/i,
    /(?:call\s+me|зовите\s+меня)\s+([^.,\n\r;!]+)/i
  ];
  for (const re of patterns){
    const m = raw.match(re);
    if (m && m[1]){
      const parts = m[1].trim().split(/\s+/).slice(0,2);
      const candidates = parts.filter(isLikelyName);
      if (candidates.length){
        return { name: candidates.join(" "), confidence: 0.95 };
      }
    }
  }

  const loose = raw.match(/\b(?:я|i\s*am|i'm|jestem|já\s+jsem)\s+([A-ZА-ЯŁŚŻŹĆŃÓÉÜÄÖ][^\s,.!?;:]+)/i);
  if (loose && isLikelyName(loose[1])) return { name: loose[1].trim(), confidence: 0.6 };

  // исправления имени
  let corr = raw.match(/не\s+([A-ZА-ЯЁŁŚŻŹĆŃÓÉÜÄÖ][^\s,]+)\s*,?\s*а\s+([A-ZА-ЯЁŁŚŻŹĆŃÓÉÜÄÖ][^\s,]+)/i)
          || raw.match(/правильно\s*[:\-]?\s*([A-ZА-ЯЁŁŚŻŹĆŃÓÉÜÄÖ][^\s,]+)/i)
          || raw.match(/not\s+([A-Z][^\s,]+)\s*,?\s*but\s+([A-Z][^\s,]+)/i);
  if (corr){
    const from = corr[1] && isLikelyName(corr[1]) ? corr[1].trim() : (knownName||null);
    const to   = (corr[2] || corr[1] || "").trim();
    if (isLikelyName(to)) return { name: to, confidence: 0.99, correctedFrom: from||undefined, ackNeeded: true };
  }
  return null;
}

/* ───────────────── Role & intent detection ───────────────── */

export function detectRole(text){
  const t = String(text||"").toLowerCase();

  const agentHints = [
    "b2b","partner","partnership","agency","agent","agency owner","owner","company","our company",
    "recruit","recruiter","hr","consulate","visa",
    "агент","агентство","партнер","партнёр","ищу партнёр","ищу партнер","компания","у меня есть кандидаты","мы отправим кандидатов",
    "визов","кадровое","рекрут"
  ];
  if (agentHints.some(h => t.includes(h))) return "agent";

  const candHints = [
    "i need job","looking for job","for myself","i'm candidate",
    "я ищу работу","для себя","кандидат","нужна работа"
  ];
  if (candHints.some(h => t.includes(h))) return "candidate";

  return null;
}

// желает «сначала поговорить/познакомиться»
function wantsConversationFirst(text){
  const t = String(text||"").toLowerCase();
  return /(хочу|давайте)\s+(поговорить|пообщаться|обсудить|познакомиться)/.test(t)
      || /let'?s\s+(talk|chat|discuss|get\s+acquainted)/.test(t)
      || /(can|may)\s+we\s+(talk|discuss)\b/.test(t);
}

// просит обзор доступных вакансий «вообще»
function asksForAnyVacancies(text){
  const t = String(text||"").toLowerCase();
  return /(любые|все)\s+доступн\w*\s+ваканси/i.test(t)
      || /(any|all)\s+available\s+vacanc/i.test(t);
}

// явный запрос ссылки/компании/деталей
function asksForLinkOrCompany(text){
  const t = String(text||"").toLowerCase();
  const link = /demand|link|ссылка|contract|контракт/.test(t);
  const company = /group\s*service|alvi\s*development|best\s*level|fortuna\s*holding|teproprint/i.test(t);
  const detail = /salary|график|schedule|жиль|интервью|video\s*interview|appointment/.test(t);
  return link || company || detail;
}

const COUNTRY_ALIASES = {
  PL: ["pl","poland","польша","polska","варшава","krakow","wroclaw","вроцлав"],
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
  warehouse: ["warehouse","склад","picker","packer","складской"],
  production: ["production","factory","завод","производство"],
  painter: ["painter","plasterer","маляр","штукатур","отделочник"],
  welder: ["welder","сварщик"],
  helper: ["helper","помощник","подсобник","labour","labor"]
};
function matchPositions(text){
  const t = String(text||"").toLowerCase();
  const res = [];
  for (const [k, aliases] of Object.entries(POSITION_ALIASES)){
    if (aliases.some(a => t.includes(a))) res.push(k);
  }
  return res;
}

/* ───────────────── Main: decide next step ───────────────── */
/**
 * Возвращает:
 *  { questionEN: string|null, metaPatch: object|null, blockCatalog?: boolean }
 */
export function decideNextStep({ session, text, snapshot }){
  const meta = readSessionMeta(session);
  const patch = { asked: { ...(meta.asked||{}) } };

  // намерение «пообщаться»
  if (wantsConversationFirst(text)){
    // не давим шагами, не включаем каталог
    return {
      questionEN: "Happy to connect. What would you like to discuss first — your goals, our process, or potential cooperation format?",
      metaPatch: patch,
      blockCatalog: true
    };
  }

  // роль
  const roleGuess = detectRole(text);
  if (roleGuess && !meta.role) patch.role = roleGuess;

  // страна/позиция из фразы
  const c = matchCountry(text);
  if (c && !meta.country_interest.includes(c)){
    patch.country_interest = [...(meta.country_interest||[]), c];
  }
  const poss = matchPositions(text);
  if (poss.length){
    const set = new Set([...(meta.position_interest||[]), ...poss]);
    patch.position_interest = [...set];
  }

  // запрос "любые доступные вакансии" → спрашиваем формат, не показываем список
  if (asksForAnyVacancies(text) && !meta.consent_overview){
    if (!recentlyAsked(meta, "overview_format")){
      setAskedPatch(patch, "overview_format");
      patch.pending_consent = "overview";
      return {
        questionEN: "I can share a quick link with all open roles, or we can narrow it down by country/position first. What’s better for you?",
        metaPatch: patch,
        blockCatalog: true
      };
    }
  }

  // если пользователь потом написал короткое «да/link/ok» — можно включить consent в другом месте;
  // здесь просто уважаем pending_consent: пока нет consent_overview — каталог не сыпем
  const explicitDetails = asksForLinkOrCompany(text);
  if (!meta.consent_overview && !explicitDetails){
    // пока не разрешено — блокируем каталог, если нет базовой инфы
    // и если ещё не знаем роль/страну — мягко спрашиваем, но без повторов
    if (!meta.role && !patch.role && !recentlyAsked(meta, "role")){
      setAskedPatch(patch, "role");
      return {
        questionEN: "Just to guide you properly: are you reaching out as an individual candidate or as an agency/company?",
        metaPatch: patch,
        blockCatalog: true
      };
    }

    const countries = patch.country_interest || meta.country_interest || [];
    if (!countries.length && !recentlyAsked(meta, "country")){
      setAskedPatch(patch, "country");
      return {
        questionEN: "Which country would you like to consider first — Czech Republic or Poland? (Serbia is possible too.)",
        metaPatch: patch,
        blockCatalog: true
      };
    }

    const positions = patch.position_interest || meta.position_interest || [];
    if (!positions.length && !recentlyAsked(meta, "position")){
      setAskedPatch(patch, "position");
      return {
        questionEN: "What kind of work fits you best: warehouse/production, construction/finishing (e.g., painter-plasterer), or something else?",
        metaPatch: patch,
        blockCatalog: true
      };
    }
  }

  // если роль = агент — спросим количество, но без повторов
  const finalRole = patch.role || meta.role;
  if (finalRole === "agent" && !meta.headcount && !patch.headcount && !recentlyAsked(meta, "headcount")){
    setAskedPatch(patch, "headcount");
    return {
      questionEN: "How many candidates do you plan to submit initially? I’ll show pricing per candidate and for your batch.",
      metaPatch: patch,
      blockCatalog: true
    };
  }

  // Всё ок — не задаём вопрос; каталог можно показывать только при:
  // - явном запросе (company/link/details), или
  // - если где-то уже установлен consent_overview (например, в reply.js по “link please”)
  return {
    questionEN: null,
    metaPatch: Object.keys(patch).length ? patch : null,
    blockCatalog: !explicitDetails && !meta.consent_overview
  };
}