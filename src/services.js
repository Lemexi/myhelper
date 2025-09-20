// /src/services.js
// Catalog-driven answers (vacancies, pricing, links) — user-facing text in EN.
// Strict legal wording (“legal support”), only active directions are shown.
// Video interview / video resume requirements are supported per vacancy.
// If user mentions multiple candidates (e.g., “x5”, “5 candidates”), we multiply upfront/final.
// Exports:
//   - findCatalogAnswer(rawText, userLang?) -> string|null     ← возвращаем СТРОКУ, чтобы не ломать reply.js
//   - enrichExpensiveAnswer(baseText, userLang?) -> string
//   - getCatalogSnapshot() -> { sig: string, openCountries: string[] }

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const CATALOG_PATH = path.join(__dirname, "catalog.json");

// ───────────────────────── Cache ─────────────────────────
let CACHE = { mtimeMs: 0, data: null, sig: "" };
function safeJSONParse(txt) { try { return JSON.parse(txt); } catch { return null; } }

function computeSig(obj) {
  const payload = JSON.stringify({
    pricing: obj?.pricing || {},
    vacancies: (obj?.vacancies || []).map(v => ({
      active: !!v.active,
      country: v.country, company: v.company, position: v.position,
      sex: v.sex, age: v.age,
      salary_text: v.salary_text, salary_net: v.salary_net, salary_gross: v.salary_gross,
      hourly_rate: v.hourly_rate,
      accommodation: v.accommodation,
      interview: v.interview || null
    })),
    country_pages: obj?.country_pages || {}
  });
  return crypto.createHash("sha1").update(payload).digest("hex");
}

function loadCatalog() {
  try {
    const stat = fs.statSync(CATALOG_PATH);
    if (!CACHE.data || CACHE.mtimeMs !== stat.mtimeMs) {
      const raw = fs.readFileSync(CATALOG_PATH, "utf8");
      const data = safeJSONParse(raw);
      if (data && typeof data === "object") {
        CACHE = { mtimeMs: stat.mtimeMs, data, sig: computeSig(data) };
      } else {
        console.warn("[services] catalog.json parse failed; keeping old cache");
      }
    }
  } catch (e) {
    console.warn("[services] catalog.json not found or unreadable:", e?.message);
  }
  if (!CACHE.data) CACHE = { mtimeMs: 0, data: { pricing: {}, vacancies: [], country_pages: {} }, sig: "" };
  return CACHE.data;
}

export function getCatalogSnapshot() {
  const data = loadCatalog();
  const open = new Set();
  for (const v of (data.vacancies || [])) if (v.active) open.add((v.country || "").toUpperCase());
  return { sig: CACHE.sig, openCountries: Array.from(open) };
}

// ───────────────────── Helpers ─────────────────────
function norm(t) { return String(t || "").toLowerCase().replace(/\s+/g, " ").trim(); }
function includesAny(t, arr) { return arr.some(w => t.includes(w)); }

const COUNTRY_MAP = [
  { code: "CZ", keywords: ["cz", "czech", "czechia", "czech republic", "чех", "чехия", "чеськ"] },
  { code: "PL", keywords: ["pl", "poland", "polska", "польша", "польск"] },
  { code: "RS", keywords: ["rs", "serbia", "srbija", "сербия"] },
  // расширяемые слоты под будущее:
  { code: "LT", keywords: ["lt", "lithuania", "lietuva", "литва"] },
  { code: "LV", keywords: ["lv", "latvia", "latvija", "латв"] },
  { code: "SK", keywords: ["sk", "slovakia", "slovensko", "словаки"] }
];
function detectCountry(text) {
  const t = norm(text);
  for (const c of COUNTRY_MAP) if (c.keywords.some(k => t.includes(k))) return c.code;
  return null;
}

const POSITION_SYNONYMS = {
  warehouse: ["warehouse", "склад", "кладовщик", "picker", "пикер", "комплектовщик", "auxiliary", "aux", "production"],
  welder:    ["welder", "welding", "сварщик", "mig", "mag", "tig", "svarka"],
  loader:    ["loader", "грузчик", "докер"],
  cook:      ["cook", "kitchen", "повар", "кухня"],
  painter:   ["painter", "plasterer", "маляр", "штукатур", "finishing"],
  helper:    ["helper", "подсоб", "помощник", "laborer"]
};
function detectPosition(text) {
  const t = norm(text);
  for (const key in POSITION_SYNONYMS) if (includesAny(t, POSITION_SYNONYMS[key])) return key;
  return null;
}

function detectCompany(text, companies) {
  const t = norm(text);
  let best = null;
  for (const c of companies) {
    const name = norm(c);
    if (!name) continue;
    if (t.includes(name)) return c;
    const parts = name.split(" ").filter(Boolean);
    const hit = parts.filter(p => p.length >= 3 && t.includes(p)).length;
    if (hit >= Math.min(2, parts.length)) best = c;
  }
  return best;
}

function getAvailableCountries(catalog) {
  const set = new Set();
  for (const v of (catalog.vacancies || [])) if (v.active) set.add((v.country || "").toUpperCase());
  return Array.from(set);
}

function listCompaniesInCountry(list) {
  const s = new Set(); for (const v of list) if (v.company) s.add(v.company); return Array.from(s);
}
function listPositionsInCountry(list) {
  const s = new Set(); for (const v of list) if (v.position) s.add(v.position); return Array.from(s);
}

// ─────────────────── Pricing helpers ───────────────────
function fmtMoney(amount, currency = "EUR") {
  const prefix = currency === "EUR" ? "€" : "";
  return `${prefix}${amount}`;
}

function extractCandidateCount(rawText) {
  const t = norm(rawText);
  const m1 = t.match(/(\d{1,3})\s*(candidates?|people|persons?|кандидат(ов|а|ы)?|челов(ек|ека|еки))/i);
  if (m1) return Math.max(1, parseInt(m1[1], 10));
  const m2 = t.match(/x\s*(\d{1,3})/i);
  if (m2) return Math.max(1, parseInt(m2[1], 10));
  return 1;
}

function formatServicePackages(pricingObj, countryCode, candidateCount = 1) {
  if (!pricingObj) return null;
  const c = countryCode ? countryCode.toUpperCase() : null;
  const lines = [];

  if (c && pricingObj.service_packages && pricingObj.service_packages[c]) {
    const pkgs = pricingObj.service_packages[c];
    lines.push(`• Service packages (${c}):`);
    for (const p of pkgs) {
      const initial = fmtMoney(p.initial, p.currency);
      const final   = fmtMoney(p.final,   p.currency);
      const note    = p.note ? ` (${p.note})` : "";
      lines.push(`   – ${p.name}: ${initial} + ${final}${note}`);
      if (candidateCount > 1) {
        const initTot = fmtMoney(p.initial * candidateCount, p.currency);
        const finTot  = fmtMoney(p.final   * candidateCount, p.currency);
        const allTot  = fmtMoney((p.initial + p.final) * candidateCount, p.currency);
        lines.push(`     ↳ For ${candidateCount} candidates: upfront ${initTot}, final ${finTot} (total ${allTot}).`);
      }
    }
    lines.push("• Prices are for legal support per candidate (not document sales). Final fee is due after PDF is issued.");
  }
  if (c && pricingObj.embassy_appointment && pricingObj.embassy_appointment[c]) {
    const ea = pricingObj.embassy_appointment[c];
    const eaInit = fmtMoney(ea.initial, ea.currency);
    const eaFin  = fmtMoney(ea.final,   ea.currency);
    lines.push(`• Embassy appointment (optional): ${eaInit} + ${eaFin}`);
    if (candidateCount > 1) {
      const initTot = fmtMoney(ea.initial * candidateCount, ea.currency);
      const finTot  = fmtMoney(ea.final   * candidateCount, ea.currency);
      const allTot  = fmtMoney((ea.initial + ea.final) * candidateCount, ea.currency);
      lines.push(`  ↳ For ${candidateCount} candidates: upfront ${initTot}, final ${finTot} (total ${allTot}).`);
    }
  }

  // Делай кратко — для WhatsApp. Если блок получился длинным — вернем null (пусть спросит дальше).
  const text = lines.join("\n");
  return text.split("\n").length > 12 ? null : text;
}

// ───────────────── Vacancy formatting ─────────────────
function formatSalary(v) {
  if (v.salary_net && typeof v.salary_net.min === "number" && typeof v.salary_net.max === "number") {
    const cur = v.salary_net.currency || "EUR";
    return `${v.salary_net.min}–${v.salary_net.max} ${cur} net`;
  }
  if (v.salary_gross && typeof v.salary_gross.min === "number" && typeof v.salary_gross.max === "number") {
    const cur = v.salary_gross.currency || "EUR";
    return `${v.salary_gross.min}–${v.salary_gross.max} ${cur} gross`;
  }
  if (v.salary_text) return v.salary_text;
  return "to be confirmed";
}

function formatAccommodation(v) {
  const a = v.accommodation;
  if (!a) return "to be confirmed";
  if (a.provided === true) {
    if (typeof a.cost_per_month === "number") return `yes, ~${a.cost_per_month}/month`;
    return "yes";
  }
  if (a.provided === false) return "no";
  if (a.note) return a.note;
  return "to be confirmed";
}
function formatTransport(v) {
  const t = v.transport_to_work;
  if (t === true) return "provided";
  if (t === false) return "no";
  if (typeof t === "string") return t;
  if (t && typeof t === "object" && t.text) return t.text;
  return "to be confirmed";
}
function formatMeals(v) {
  const m = v.meals_provided;
  if (m === true) return "provided";
  if (m === false) return "no";
  return "to be confirmed";
}

function formatInterview(v) {
  const i = v.interview || {};
  function reqToText(flag, optionalText = "optional (we can arrange on request)") {
    if (flag === true) return "required";
    if (flag === false) return "not required";
    if (flag === "optional") return optionalText;
    return "to be confirmed";
  }
  const rows = [];
  rows.push(`• Employer video interview: ${i.employer_video_required !== undefined ? reqToText(i.employer_video_required) : "optional (we can arrange on request)"}`);
  if (i.candidate_video_resume_required !== undefined) rows.push(`• Candidate video résumé: ${reqToText(i.candidate_video_resume_required)}`);
  if (i.portfolio_video_required !== undefined) rows.push(`• Video of recent works: ${reqToText(i.portfolio_video_required)}`);
  if (i.notes) rows.push(`• Interview notes: ${i.notes}`);
  return rows.join("\n");
}

function formatVacancy(v, countryPages = {}) {
  const sal = formatSalary(v);
  const acc = formatAccommodation(v);
  const transport = formatTransport(v);
  const meals = formatMeals(v);
  const sex = v.sex ? v.sex : "Male/Female";
  const age = v.age ? v.age : "18+";
  const linkDemand = countryPages[(v.country || "").toUpperCase()]?.demand || null;

  const lines = [
    v.company ? `• Company: ${v.company}${v.city ? `, ${v.city}` : ""}` : (v.city ? `• City: ${v.city}` : null),
    v.position ? `• Position: ${v.position}` : null,
    `• Gender/Age: ${sex}${age ? `, ${age}` : ""}`,
    v.employees_needed ? `• Headcount: ${v.employees_needed}` : null,
    v.hours_per_month ? `• Hours/month: ${v.hours_per_month}` : (v.workhours_monthly ? `• Hours/month: ${v.workhours_monthly}` : null),
    v.schedule ? `• Schedule: ${v.schedule}` : (v.workday ? `• Schedule: ${v.workday}` : null),
    `• Salary: ${sal}`,
    v.hourly_rate ? `• Hourly rate: ${v.hourly_rate}` : null,
    `• Accommodation: ${acc}`,
    `• Transport: ${transport}`,
    `• Meals: ${meals}`,
    formatInterview(v),
  ].filter(Boolean);

  if (v.notes) lines.push(`• Notes: ${v.notes}`);
  if (linkDemand) lines.push(`🔗 Demand page: ${linkDemand}`);

  // Срезаем длину: не больше 10–12 строк, чтобы не "убивать" стиль.
  const compact = lines.slice(0, 12).join("\n");
  return compact;
}

// ───────────────── Matching ─────────────────
function findMatches({ catalog, country, companyName, positionKey }) {
  let list = (catalog.vacancies || []).filter(v => v.active);
  if (country) list = list.filter(v => (v.country || "").toUpperCase() === country.toUpperCase());
  if (companyName) list = list.filter(v => norm(v.company || "").includes(norm(companyName)));
  if (positionKey) {
    list = list.filter(v => {
      const vp = norm(v.position || "");
      if (!vp) return false;
      if (vp.includes(positionKey)) return true;
      const syn = POSITION_SYNONYMS[positionKey] || [];
      return syn.some(s => vp.includes(s));
    });
  }
  return list;
}
function pickTop(list, n = 2) { return list.slice(0, n); }

// ───────────────── Public API ─────────────────
// Возвращаем СТРОКУ (короткую, WhatsApp-friendly), чтобы reply.js мог отдать её напрямую.
export async function findCatalogAnswer(rawText, _userLang = "en") {
  const catalog = loadCatalog();
  const text = norm(rawText);
  const availableCountries = getAvailableCountries(catalog);
  const countryPages = catalog.country_pages || {};
  const candidateCount = extractCandidateCount(rawText);

  const country = detectCountry(text);
  const positionKey = detectPosition(text);
  const companies = (catalog.vacancies || []).map(v => v.company).filter(Boolean);
  const companyName = detectCompany(text, companies);

  const asksAll = /(all countries|all directions|все страны|все направления)/i.test(rawText);
  const asksWhat = /(what (do you have|positions|is available)|available|какие вакансии|что (есть|доступно))/i.test(rawText);
  const isVacancyIntent = asksAll || asksWhat || includesAny(text, ["работ", "ваканси", "job", "position", "визы", "visa", "оформлен", "контракт"]);

  // Если намерение про вакансии не уверенное — не вмешиваемся (пусть ответит LLM "личностью").
  if (!isVacancyIntent && !country && !positionKey && !companyName) return null;

  // Указана закрытая страна
  if (country && !availableCountries.includes(country)) {
    const alt = availableCountries.length ? `Open now: ${availableCountries.join(", ")}.` : "Recruitment is temporarily closed.";
    const linkDemand = countryPages[country]?.demand ? `\nDocs page: ${countryPages[country].demand}` : "";
    return `Direction ${country} is closed. ${alt}${linkDemand}\n👉 Choose a country — I’ll send roles, salaries and the Demand link.`;
  }

  // Обзор по всем
  if (asksAll && availableCountries.length) {
    const perCountry = [];
    for (const c of availableCountries) {
      const list = (catalog.vacancies || []).filter(v => v.active && (v.country || "").toUpperCase() === c);
      const top = pickTop(list, 2)
        .map(v => `— ${v.company}: ${v.position} — ${formatSalary(v)}`)
        .join("\n");
      const link = countryPages[c]?.demand ? `\n🔗 Demand page: ${countryPages[c].demand}` : "";
      perCountry.push(`${c}:\n${top}${link}`);
    }
    const msg = `Open directions:\n\n${perCountry.join("\n\n")}\n\n👉 Tell me a country + position — I’ll send terms & the Demand link.`;
    return msg.length > 900 ? msg.slice(0, 900) + "\n…" : msg;
  }

  // "Что есть?" без страны → просим выбрать
  if (asksWhat && !country) {
    if (!availableCountries.length) {
      return "Recruitment is temporarily closed. I can put you on priority and notify when it opens.";
    }
    return `Open now: ${availableCountries.join(", ")}.\n👉 Which country suits you? I’ll send companies, roles, salaries and the Demand link.`;
  }

  // Поиск совпадений
  let matches = findMatches({ catalog, country, companyName, positionKey });

  // Страна есть, но совпадений нет → мини-обзор + Demand
  if (!matches.length && country && availableCountries.includes(country)) {
    const byCountry = (catalog.vacancies || []).filter(v => v.active && (v.country || "").toUpperCase() === country);
    if (byCountry.length) {
      const posList  = listPositionsInCountry(byCountry);
      const compList = listCompaniesInCountry(byCountry);
      const linkDemand = countryPages[country]?.demand ? `\n🔗 Demand page: ${countryPages[country].demand}` : "";
      const lines = [
        `Open in ${country}:`,
        posList.length ? `• Positions: ${posList.slice(0,6).join(", ")}` : null,
        compList.length ? `• Companies: ${compList.slice(0,6).join(", ")}` : null,
        linkDemand,
        "👉 Tell me a position or company — I’ll send full terms."
      ].filter(Boolean);
      return lines.join("\n");
    }
  }

  // Много совпадений → показываем максимум 2 блока, кратко
  if (matches.length >= 2) {
    const top = pickTop(matches, 2);
    const blocks = top.map(v => formatVacancy(v, countryPages));
    const pkgBlock = formatServicePackages(catalog.pricing, country || (top[0]?.country), candidateCount);
    const body = [blocks.join("\n\n"), pkgBlock].filter(Boolean).join("\n\n");
    const msg =
`${body}

👉 Which company fits? I’ll send a checklist and the Demand link.`;
    // ограничение длины для мессенджера
    return msg.length > 1200 ? msg.slice(0, 1200) + "\n…" : msg;
  }

  // Одно совпадение → один аккуратный блок + цены (если коротко) + контракт
  if (matches.length === 1) {
    const v = matches[0];
    const block = formatVacancy(v, countryPages);
    const priceBlock = formatServicePackages(catalog.pricing, v.country, candidateCount);
    const contractLink = countryPages[(v.country || "").toUpperCase()]?.contract;
    const tail = [
      priceBlock ? priceBlock : null,
      contractLink ? `• Sample employment contract: ${contractLink}` : null,
      "👉 If this fits, I’ll send a document checklist and we can start registration."
    ].filter(Boolean).join("\n");

    const msg = [block, tail].filter(Boolean).join("\n\n");
    return msg.length > 1200 ? msg.slice(0, 1200) + "\n…" : msg;
  }

  // Ничего уверенного → не вмешиваемся (пусть ответит LLM)
  return null;
}

// ─────────────── Enrich “expensive” answers ───────────────
export async function enrichExpensiveAnswer(baseText, _userLang = "en") {
  const catalog = loadCatalog();
  const vac = Array.isArray(catalog.vacancies) ? catalog.vacancies.filter(v => v.active) : [];
  if (!vac.length) return baseText;

  const byCountry = vac.reduce((acc, v) => {
    const c = (v.country || "").toUpperCase();
    if (!c) return acc;
    (acc[c] ||= []).push(v);
    return acc;
  }, {});

  function rangeText(list) {
    let min = Infinity, max = -Infinity, cur = "EUR";
    for (const v of list) {
      const s = v.salary_net || v.salary_gross;
      if (s && typeof s.min === "number") min = Math.min(min, s.min);
      if (s && typeof s.max === "number") max = Math.max(max, s.max);
      if (s && s.currency) cur = s.currency;
    }
    if (!isFinite(min) || !isFinite(max)) return null;
    return `${min}–${max} ${cur}`;
  }

  const czRange = byCountry.CZ ? rangeText(byCountry.CZ) : null;
  const allRange = rangeText(vac) || null;

  function avgAccommodation(list) {
    const nums = [];
    for (const v of list) {
      const c = v?.accommodation?.cost_per_month;
      if (typeof c === "number") nums.push(c);
    }
    if (!nums.length) return null;
    const sum = nums.reduce((a, b) => a + b, 0);
    return Math.round(sum / nums.length);
  }
  const czAcc = byCountry.CZ ? avgAccommodation(byCountry.CZ) : null;

  const extra = [];
  if (czRange) extra.push(`• Czechia: typical net range ${czRange}`);
  else if (allRange) extra.push(`• Across our projects: net range ${allRange}`);
  if (czAcc) extra.push(`• Accommodation in CZ ≈ ${czAcc}/month (unless employer covers it)`);

  if (!extra.length) return baseText;
  const enriched = baseText + `\n\n📌 Benchmarks:\n` + extra.join("\n") +
    `\nWe can start with 1–2 candidates — I’ll send the invoice and a short checklist.`;
  return enriched.length > 1200 ? enriched.slice(0, 1200) + "\n…" : enriched;
}
