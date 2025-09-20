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
    role: m.role || null, // "candidate" | "agent" | null
    country_interest: Array.isArray(m.country_interest) ? m.country_interest : [],
    position_interest: Array.isArray(m.position_interest) ? m.position_interest : [],
    headcount: Number.isFinite(m.headcount) ? m.headcount : null,
    asked: m.asked || {},
    last_question_key: m.last_question_key || null,
    last_question_ts: m.last_question_ts || 0,
    consent_overview: !!m.consent_overview,
    pending_consent: m.pending_consent || null,
    side_topic_streak: Number.isFinite(m.side_topic_streak) ? m.side_topic_streak : 0,
    greeted_after_name: !!m.greeted_after_name
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
    "я ищу работу","для себя","кандидат","нужна работа","работу для себя"
  ];
  if (candHints.some(h => t.includes(h))) return "candidate";

  return null;
}

function wantsConversationFirst(text){
  const t = String(text||"").toLowerCase();
  return /(хочу|давайте)\s+(поговорить|пообщаться|обсудить|познакомиться)/.test(t)
      || /let'?s\s+(talk|chat|discuss|get\s+acquainted)/.test(t)
      || /(can|may)\s+we\s+(talk|discuss)\b/.test(t);
}

function asksForAnyVacancies(text){
  const t = String(text||"").toLowerCase();
  return /(любые|все)\s+доступн\w*\s+ваканси/i.test(t)
      || /(any|all)\s+available\s+vacanc/i.test(t);
}

function asksForLinkOrCompany(text){
  const t = String(text||"").toLowerCase();
  const link = /demand|link|ссылка|contract|контракт/.test(t);
  const company = /group\s*service|alvi\s*development|best\s*level|fortuna\s*holding|teproprint/i.test(t);
  const detail = /salary|график|schedule|жиль|интервью|video\s*interview|appointment|accommodation|hours|ставк/i.test(t);
  return link || company || detail;
}

// лёгкая эвристика off-topic
function isOffTopic(text){
  const t = String(text||"").toLowerCase();
  const businessHints = [
    "czech","poland","serbia","чех","польш","серб","vacanc","ваканс","salary","ставк",
    "accommodation","жиль","appointment","назначени","contract","контракт","договор",
    "candidate","кандидат","agency","агент","partnership","партнер","b2b","pilot","invoice"
  ];
  const smalltalk = /(погод|weather|машин|car|auto|football|футбол|music|музык|как дела|how are you)/i.test(t);
  const hasBiz = businessHints.some(k => t.includes(k));
  return smalltalk && !hasBiz;
}

/* ───────────────── Country/Position detection ───────────────── */

const COUNTRY_ALIASES = {
  PL: ["pl","poland","polska","польша","polandia","варшава","krakow","wroclaw","вроцлав"],
  CZ: ["cz","czech","czechia","czech republic","чехия","praha","prague","прага","брно","brno"],
  RS: ["rs","serbia","сербия","belgrade","белград","novi sad","нови сад"]
};
function matchCountry(text){
  const t = String(text||"").toLowerCase();
  for (const [code, aliases] of Object.entries(COUNTRY_ALIASES)){
    if (aliases.some(a => t.includes(a))) return code;
  }
  return null;
}

const POSITION_ALIASES = {
  warehouse: ["warehouse","склад","кладовщик","picker","packer","комплектовщик","production","factory","завод","производ"],
  painter: ["painter","plasterer","finishing","отдел","маляр","штукатур"],
  welder: ["welder","сварщик","mig","mag","tig","svarka"],
  helper: ["helper","подсоб","помощник","laborer","labourer"],
  driver: ["driver","водител"]
};
function matchPositions(text){
  const t = String(text||"").toLowerCase();
  const res = [];
  for (const [k, aliases] of Object.entries(POSITION_ALIASES)){
    if (aliases.some(a => t.includes(a))) res.push(k);
  }
  return res;
}

/* ───────────────── Name ask policy (shared) ───────────────── */

export function shouldAskName(meta){
  if (!meta) return true;
  if (!meta.asked || !meta.asked.ask_name) return true;
  return (NOW() - (meta.last_question_ts || 0)) > 90_000 || meta.last_question_key !== "ask_name";
}

/* ───────────────── Main: decide next step ───────────────── */
/**
 * Возвращает объект:
 *  {
 *    questionEN: string|null,   // задать вопрос вместо свободного ответа
 *    nudgeEN: string|null,      // ДОБАВИТЬ к обычному ответу как мягкий мостик
 *    metaPatch: object|null,    // патч в sessions.orchestrator
 *    blockCatalog?: boolean     // не показывать каталог
 *  }
 *
 * Правило «живого диалога»:
 *  • На офтоп мы отвечаем нормально (LLM), а каждые 3–4 сообщения добавляем nudgeEN.
 *  • questionEN используется для критичных шагов (входной питч после имени, явная развилка).
 */
export function decideNextStep({ session, text, snapshot }){
  const meta = readSessionMeta(session);
  const patch = { asked: { ...(meta.asked||{}) } };
  const t = String(text||"");

  // 0) Не давим, если собеседник явно хочет просто «пообщаться»
  if (wantsConversationFirst(t)){
    return {
      questionEN: null,
      nudgeEN: "Happy to connect. When you’re ready, tell me if you are a candidate or an agency/company — I’ll tailor the next steps.",
      metaPatch: patch,
      blockCatalog: true
    };
  }

  // 1) Вычислим роль/страну/позиции из текущей фразы
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

  // 2) Живое интро — один раз сразу после имени
  if (!meta.greeted_after_name){
    patch.greeted_after_name = true;
    const intro = [
      "Nice to meet you — I’m Viktor Shimanski from RenovoGo (12+ years in legal employment across the EU).",
      "To guide you properly, are you reaching out as an individual candidate or as an agency/company?"
    ].join(" ");
    setAskedPatch(patch, "role");
    return { questionEN: intro, nudgeEN: null, metaPatch: patch, blockCatalog: true };
  }

  // 3) Подсчёт офтопа
  let streak = meta.side_topic_streak || 0;
  if (isOffTopic(t)) streak += 1; else streak = 0;
  patch.side_topic_streak = streak;

  // Если офтоп >=3 — возвращаем nudgeEN (мягкий мостик), но НЕ блокируем обычный ответ
  if (streak >= 3) {
    const needRole = !meta.role && !patch.role && !recentlyAsked(meta, "role");
    const countries = patch.country_interest || meta.country_interest || [];
    const needCountry = !countries.length && !recentlyAsked(meta, "country");
    const positions = patch.position_interest || meta.position_interest || [];
    const needPosition = !positions.length && !recentlyAsked(meta, "position");

    let nudge = null;
    if (needRole) {
      setAskedPatch(patch, "role");
      nudge = "Quick check so I don’t waste your time: are you a candidate or an agency/company?";
    } else if (needCountry) {
      setAskedPatch(patch, "country");
      nudge = "Which country should we consider first — Czech Republic or Poland? (Serbia is possible too.)";
    } else if (needPosition) {
      setAskedPatch(patch, "position");
      nudge = "What kind of work fits you best: warehouse/production, construction/finishing (e.g., painter-plasterer), or something else?";
    }

    // Если есть что «подтолкнуть» — отдадим nudgeEN, каталог временно блокируем
    if (nudge) {
      return { questionEN: null, nudgeEN: nudge, metaPatch: patch, blockCatalog: true };
    }
    // Иначе просто позволяем свободный ответ без каталога
    return { questionEN: null, nudgeEN: null, metaPatch: patch, blockCatalog: true };
  }

  // 4) «Покажи все вакансии» → сначала согласие на обзор (без каталога)
  if (asksForAnyVacancies(t) && !meta.consent_overview){
    if (!recentlyAsked(meta, "overview_format")){
      setAskedPatch(patch, "overview_format");
      patch.pending_consent = "overview";
      return {
        questionEN: "I can share a quick link with all open roles, or we can narrow it down by country/position first. What’s better for you?",
        nudgeEN: null,
        metaPatch: patch,
        blockCatalog: true
      };
    }
  }

  // 5) Пока нет согласия на обзор и нет явной конкретики — уточняем по делу, но без повторов
  const explicitDetails = asksForLinkOrCompany(t);
  if (!meta.consent_overview && !explicitDetails){
    if (!meta.role && !patch.role && !recentlyAsked(meta, "role")){
      setAskedPatch(patch, "role");
      return {
        questionEN: "Just to guide you properly: are you reaching out as an individual candidate or as an agency/company?",
        nudgeEN: null,
        metaPatch: patch,
        blockCatalog: true
      };
    }

    const countries = patch.country_interest || meta.country_interest || [];
    if (!countries.length && !recentlyAsked(meta, "country")){
      setAskedPatch(patch, "country");
      return {
        questionEN: "Which country would you like to consider first — Czech Republic or Poland? (Serbia is possible too.)",
        nudgeEN: null,
        metaPatch: patch,
        blockCatalog: true
      };
    }

    const positions = patch.position_interest || meta.position_interest || [];
    if (!positions.length && !recentlyAsked(meta, "position")){
      setAskedPatch(patch, "position");
      return {
        questionEN: "What kind of work fits you best: warehouse/production, construction/finishing (e.g., painter-plasterer), or something else?",
        nudgeEN: null,
        metaPatch: patch,
        blockCatalog: true
      };
    }
  }

  // 6) Роль агент → спросить количество
  const finalRole = patch.role || meta.role;
  if (finalRole === "agent" && !meta.headcount && !patch.headcount && !recentlyAsked(meta, "headcount")){
    setAskedPatch(patch, "headcount");
    return {
      questionEN: "How many candidates do you plan to submit initially? I’ll show pricing per candidate and for your batch.",
      nudgeEN: null,
      metaPatch: patch,
      blockCatalog: true
    };
  }

  // 7) Ок — не мешаем диалогу; каталог откроется только при явной конкретике/consent
  return {
    questionEN: null,
    nudgeEN: null,
    metaPatch: Object.keys(patch).length ? patch : null,
    blockCatalog: !explicitDetails && !meta.consent_overview
  };
}