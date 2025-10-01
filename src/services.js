// /src/services.js
// Короткие, человеческие ответы из catalog.json. Ничего не придумываем сверх каталога.

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const CATALOG_PATH = path.join(__dirname, "catalog.json");

let CACHE = { mtimeMs: 0, data: null, sig: "" };

// ─────────── utils: io/cache ───────────
function safeJSONParse(txt) { try { return JSON.parse(txt); } catch { return null; } }

function computeSig(obj) {
  const payload = JSON.stringify({
    pricing: obj?.pricing || {},
    vacancies: (obj?.vacancies || []).map(v => ({
      active: !!v.active,
      country: v.country, company: v.company, position: v.position,
      city: v.city, salary_text: v.salary_text, hourly_rate: v.hourly_rate,
      salary_net: v.salary_net, salary_gross: v.salary_gross,
      accommodation: v.accommodation, interview: v.interview || null
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

// ─────────── utils: text/normalize ───────────
function norm(t) { return String(t || "").toLowerCase().replace(/\s+/g, " ").trim(); }
function includesAny(t, arr) { return arr.some(w => t.includes(w)); }
function uniq(arr) { return Array.from(new Set(arr)); }
function title(s) { return (s || "").replace(/\s+/g, " ").trim(); }

const COUNTRY_LABEL = {
  CZ: "Чехия",
  PL: "Польша",
  RS: "Сербия",
  LT: "Литва",
  LV: "Латвия",
  SK: "Словакия"
};

const COUNTRY_MAP = [
  { code: "CZ", keywords: ["cz", "czech", "czechia", "czech republic", "чех", "чехия", "чеськ"] },
  { code: "PL", keywords: ["pl", "poland", "polska", "польша", "польск"] },
  { code: "RS", keywords: ["rs", "serbia", "srbija", "сербия"] },
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
  warehouse: ["warehouse", "склад", "кладовщик", "picker", "пикер", "комплектовщик", "auxiliary", "aux", "production", "производств"],
  welder:    ["welder", "welding", "сварщик", "mig", "mag", "tig", "svarka", "сварк"],
  loader:    ["loader", "грузчик", "докер"],
  cook:      ["cook", "kitchen", "повар", "кухн"],
  painter:   ["painter", "plasterer", "маляр", "штукатур", "finishing", "отделоч"],
  helper:    ["helper", "подсоб", "помощник", "laborer"]
};
function detectPositionKey(text) {
  const t = norm(text);
  for (const key in POSITION_SYNONYMS) if (includesAny(t, POSITION_SYNONYMS[key])) return key;
  return null;
}

function positionMatchesKey(v, key) {
  if (!key) return true;
  const p = norm(v.position || "");
  if (!p) return false;
  if (p.includes(key)) return true;
  const syn = POSITION_SYNONYMS[key] || [];
  return syn.some(s => p.includes(s));
}

// ─────────── formatting ───────────
function formatSalaryShort(v) {
  if (v.salary_text) return v.salary_text;
  const s = v.salary_net || v.salary_gross;
  if (s && typeof s.min === "number") {
    const cur = s.currency || "EUR";
    return `от ${s.min} ${cur}${v.salary_net ? " net" : ""}`;
  }
  return "оплата по договорённости";
}

function renderVacancyCard(v, demandUrl, contractUrl) {
  const lines = [];
  const countryCode = (v.country || "").toUpperCase();
  const countryName = COUNTRY_LABEL[countryCode] || v.country || countryCode;

  lines.push(`📍 Страна: ${countryName}${v.city ? ` (${title(v.city)})` : ""}`);
  if (v.company)  lines.push(`🏢 Компания: ${title(v.company)}`);
  if (v.position) lines.push(`👷 Позиция: ${title(v.position)}`);
  lines.push(`💰 Оплата: ${formatSalaryShort(v)}`);
  if (v.workhours_monthly || v.hours_per_month) {
    lines.push(`⏱️ Часы/мес: ${v.workhours_monthly || v.hours_per_month}`);
  }
  if (v.schedule || v.workday) {
    lines.push(`📆 График: ${v.schedule || v.workday}`);
  }
  if (v.accommodation?.provided) {
    const accCost = v.accommodation?.cost_per_month != null ? ` (~${v.accommodation.cost_per_month} €/мес)` : "";
    lines.push(`🛏️ Жильё: предоставляется${accCost}${v.accommodation?.note ? ` — ${v.accommodation.note}` : ""}`);
  } else if (v.accommodation) {
    lines.push(`🛏️ Жильё: ${v.accommodation?.note ? v.accommodation.note : "не указано"}`);
  }
  if (v.transport_to_work != null) {
    const tt = typeof v.transport_to_work === "string" ? v.transport_to_work : (v.transport_to_work ? "предоставляется" : "самостоятельно");
    lines.push(`🚌 Транспорт на работу: ${tt}`);
  }
  if (v.meals_provided != null) {
    lines.push(`🍽️ Питание: ${v.meals_provided ? "предоставляется" : "самостоятельно"}`);
  }
  if (v.interview?.employer_video_required) {
    lines.push(`🎥 Собеседование с работодателем: короткое видео до подтверждения`);
  } else if (v.interview) {
    lines.push(`🎥 Собеседование: по запросу / не обязательно`);
  }
  if (v.notes) lines.push(`ℹ️ ${title(v.notes)}`);

  const docs = [];
  if (demandUrl)   docs.push(`demand: ${demandUrl}`);
  if (contractUrl) docs.push(`contract: ${contractUrl}`);
  if (docs.length) lines.push(`📄 Документы: ${docs.join(" · ")}`);

  return lines.join("\n");
}

// ─────────── intent words ───────────
const VACANCY_WORDS = [
  "vacanc", "position", "role", "jobs", "available",
  "ваканси", "позици", "работа", "что есть по", "какие есть", "что доступно", "список", "каталог", "страны доступны"
];
const DETAIL_WORDS = ["detail", "full", "terms", "подроб", "деталь", "полные", "чеклист"];

// ─────────── helpers over catalog ───────────
function getActiveByCountry(catalog) {
  const map = new Map(); // code -> vacancies[]
  for (const v of (catalog.vacancies || [])) {
    if (!v.active) continue;
    const code = (v.country || "").toUpperCase();
    if (!code) continue;
    if (!map.has(code)) map.set(code, []);
    map.get(code).push(v);
  }
  return map;
}

function uniquePositions(list) {
  return uniq(list.map(v => title(v.position || "")).filter(Boolean));
}

function findByPositionAcrossCountries(catalog, positionKeyOrText) {
  const key = detectPositionKey(positionKeyOrText) || norm(positionKeyOrText);
  const map = new Map(); // code -> matches[]
  for (const v of (catalog.vacancies || [])) {
    if (!v.active) continue;
    const code = (v.country || "").toUpperCase();
    const match = detectPositionKey(positionKeyOrText)
      ? positionMatchesKey(v, key)  // по ключу-синонимам
      : norm(v.position || "").includes(key); // по подстроке
    if (match) {
      if (!map.has(code)) map.set(code, []);
      map.get(code).push(v);
    }
  }
  return map;
}

// ─────────── public API ───────────
export async function findCatalogAnswer(rawText, _userLang = "ru") {
  const catalog = loadCatalog();
  const text = norm(rawText);
  const countryPages = catalog.country_pages || {};
  const activeByCountry = getActiveByCountry(catalog);
  const availableCountries = Array.from(activeByCountry.keys());

  const askedCountry = detectCountry(text);
  const askedPositionKey = detectPositionKey(text);
  const wantDetail = DETAIL_WORDS.some(w => text.includes(w));
  const vacancySignal = VACANCY_WORDS.some(w => text.includes(w)) || !!askedCountry || !!askedPositionKey;

  if (!vacancySignal) return null; // не триггерим каталог без сигнала

  // 1) «Какие страны доступны?»
  if (/какие\s+страны|what\s+countries|countries\s+available/.test(text)) {
    if (!availableCountries.length) {
      return "Набор временно закрыт. Могу поставить вас в приоритет и уведомить об открытии.";
    }
    const lines = availableCountries.map(c => {
      const label = COUNTRY_LABEL[c] || c;
      const pages = [];
      if (countryPages[c]?.demand)   pages.push(`demand: ${countryPages[c].demand}`);
      if (countryPages[c]?.contract) pages.push(`contract: ${countryPages[c].contract}`);
      return `• ${label}${pages.length ? ` — ${pages.join(" · ")}` : ""}`;
    });
    return `Сейчас набираем по странам:\n${lines.join("\n")}\n\nНазовите страну и позицию — отправлю условия.`;
  }

  // 2) Если нет страны → краткий обзор по странам (динамически)
  if (!askedCountry) {
    if (!availableCountries.length) {
      return "Набор временно закрыт. Могу поставить вас в приоритет и уведомить об открытии.";
    }

    // Если пользователь назвал позицию без страны — покажем, где такая есть
    if (askedPositionKey) {
      const found = findByPositionAcrossCountries(catalog, askedPositionKey);
      if (found.size === 0) {
        return "Такой позиции сейчас нет в активном наборе. Могу предложить склад/производство."
      }
      if (found.size === 1) {
        // Единственная страна — сразу карточки
        const [code, list] = Array.from(found.entries())[0];
        const demand = countryPages[code]?.demand;
        const contract = countryPages[code]?.contract;
        const cards = list.slice(0, 3).map(v => renderVacancyCard(v, demand, contract)).join("\n\n");
        return `${cards}`;
      }
      // Несколько стран — короткий ориентир
      const lines = Array.from(found.entries()).map(([code, list]) => {
        const label = COUNTRY_LABEL[code] || code;
        const pos = uniquePositions(list).join(", ");
        const docs = [];
        if (countryPages[code]?.demand)   docs.push(`demand: ${countryPages[code].demand}`);
        if (countryPages[code]?.contract) docs.push(`contract: ${countryPages[code].contract}`);
        const docLine = docs.length ? ` (${docs.join(" · ")})` : "";
        return `• ${label}: ${pos}${docLine}`;
      });
      return `Эта позиция доступна в:\n${lines.join("\n")}\n\nНазовите страну — пришлю полные условия.`;
    }

    // Общий обзор: страна → список позиций
    const lines = availableCountries.map(code => {
      const label = COUNTRY_LABEL[code] || code;
      const list = activeByCountry.get(code) || [];
      const pos = uniquePositions(list).join(", ");
      const docs = [];
      if (countryPages[code]?.demand)   docs.push(`demand: ${countryPages[code].demand}`);
      if (countryPages[code]?.contract) docs.push(`contract: ${countryPages[code].contract}`);
      const docLine = docs.length ? ` (${docs.join(" · ")})` : "";
      return `• ${label}: ${pos}${docLine}`;
    });
    return `Сейчас открыто:\n${lines.join("\n")}\n\nНапишите страну и позицию — пришлю условия.`;
  }

  // 3) Страна указана → подберём внутри неё
  const code = askedCountry;
  if (!availableCountries.includes(code)) {
    const alt = availableCountries.length
      ? `Сейчас набираем: ${availableCountries.map(c => COUNTRY_LABEL[c] || c).join(", ")}.`
      : "Набор временно закрыт.";
    const docs = [];
    if (countryPages[code]?.demand)   docs.push(`demand: ${countryPages[code].demand}`);
    if (countryPages[code]?.contract) docs.push(`contract: ${countryPages[code].contract}`);
    const docLine = docs.length ? `\nСтраница документов: ${docs.join(" · ")}` : "";
    return `${COUNTRY_LABEL[code] || code}: набор закрыт. ${alt}${docLine}`;
  }

  // Список вакансий в выбранной стране
  let matches = (activeByCountry.get(code) || []).slice();
  if (askedPositionKey) {
    matches = matches.filter(v => positionMatchesKey(v, askedPositionKey));
  }

  if (!matches.length) {
    // Страна есть, но по ключу ничего — покажем весь список позиций этой страны
    const pos = uniquePositions(activeByCountry.get(code) || []).join(", ");
    const docs = [];
    if (countryPages[code]?.demand)   docs.push(`demand: ${countryPages[code].demand}`);
    if (countryPages[code]?.contract) docs.push(`contract: ${countryPages[code].contract}`);
    const docLine = docs.length ? `\nДокументы: ${docs.join(" · ")}` : "";
    return `${COUNTRY_LABEL[code] || code}: доступны позиции — ${pos}.${docLine}\nУточните позицию — отправлю условия.`;
  }

  // Если запрос общим списком — кратко перечислим; при явном "детали" — карточки
  const demand = countryPages[code]?.demand;
  const contract = countryPages[code]?.contract;

  if (!wantDetail && !askedPositionKey) {
    // Обзор по стране
    const brief = uniq(matches.map(v => `${title(v.position)} — ${formatSalaryShort(v)}`)).slice(0, 5).join(" | ");
    const docs = [];
    if (demand)   docs.push(`demand: ${demand}`);
    if (contract) docs.push(`contract: ${contract}`);
    const docLine = docs.length ? `\nДокументы: ${docs.join(" · ")}` : "";
    return `${COUNTRY_LABEL[code] || code}: ${brief}.${docLine}\nНапишите позицию — пришлю полные условия.`;
  }

  // Полные условия (карточки). Если выбрана позиция — отдадим карточки этой позиции; иначе — топ-3.
  const top = (askedPositionKey ? matches : matches.slice(0, 3));
  const cards = top.map(v => renderVacancyCard(v, demand, contract)).join("\n\n");
  return cards;
}
