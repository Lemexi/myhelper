// /src/services.js
// Каталог вакансий/услуг и цен + хэлперы для ответов из каталога.
// Легко редактируется через src/catalog.json без изменения логики ИИ.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ─────────────────────────────────────────────────────────────
// Файл каталога (JSON) + простое кэширование на чтение
// ─────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const CATALOG_PATH = path.join(__dirname, "catalog.json");

let CACHE = { mtimeMs: 0, data: null };

function safeJSONParse(txt) {
  try { return JSON.parse(txt); } catch { return null; }
}

function loadCatalog() {
  try {
    const stat = fs.statSync(CATALOG_PATH);
    if (!CACHE.data || CACHE.mtimeMs !== stat.mtimeMs) {
      const raw = fs.readFileSync(CATALOG_PATH, "utf8");
      const data = safeJSONParse(raw);
      if (data && typeof data === "object") {
        CACHE = { mtimeMs: stat.mtimeMs, data };
      } else {
        // если json битый — не обновляем кеш
        console.warn("[services] catalog.json parse failed; keeping old cache");
      }
    }
  } catch (e) {
    console.warn("[services] catalog.json not found or unreadable:", e?.message);
  }
  return CACHE.data || { pricing: {}, vacancies: [] };
}

// ─────────────────────────────────────────────────────────────
// Нормализация и простая классификация
// ─────────────────────────────────────────────────────────────
function norm(t) {
  return String(t || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const COUNTRY_MAP = [
  { code: "CZ", keywords: ["cz", "czech", "czechia", "чех", "чехия", "чеськ", "czech republic", "czech rep.", "捷克"] },
  { code: "PL", keywords: ["pl", "poland", "pol", "польша", "польск", "polska", "波兰"] },
  { code: "LT", keywords: ["lt", "lithuania", "литва", "liet", "lietuva", "立陶宛"] },
  { code: "LV", keywords: ["lv", "latvia", "латв", "latvija"] },
  { code: "SK", keywords: ["sk", "slovakia", "словаки", "slovensko"] },
];

function detectCountry(text) {
  const t = norm(text);
  for (const c of COUNTRY_MAP) {
    if (c.keywords.some(k => t.includes(k))) return c.code;
  }
  return null;
}

function includesAny(t, arr) {
  return arr.some(w => t.includes(w));
}

// Примитивная синонимика по позициям (можно расширять в catalog.json)
const POSITION_SYNONYMS = {
  warehouse: ["warehouse", "склад", "складе", "складской", "кладовщик", "picker", "пикер", "комплектовщик", "auxiliary", "aux"],
  welder:    ["welder", "сварщик", "mig", "mag", "tig", "svarka", "welding"],
  loader:    ["loader", "грузчик", "докер"],
  cook:      ["cook", "повар", "кухня", "kitchen"],
};

function detectPosition(text) {
  const t = norm(text);
  for (const key in POSITION_SYNONYMS) {
    if (includesAny(t, POSITION_SYNONYMS[key])) return key;
  }
  // возможно, в сообщении написано точное название из каталога — вернём его
  return null;
}

function detectCompany(text, companies) {
  const t = norm(text);
  let best = null;
  for (const c of companies) {
    const name = norm(c);
    if (!name) continue;
    if (t.includes(name)) {
      best = c;
      break;
    }
    // слабое совпадение по словам
    const parts = name.split(" ").filter(Boolean);
    const hit = parts.filter(p => p.length >= 3 && t.includes(p)).length;
    if (hit >= Math.min(2, parts.length)) best = c;
  }
  return best;
}

// ─────────────────────────────────────────────────────────────
// Форматирование ответа для человека (WhatsApp-стиль)
// ─────────────────────────────────────────────────────────────
function formatVacancy(v, userLang = "ru") {
  const sal = v.salary_net
    ? `${v.salary_net.min}–${v.salary_net.max} ${v.salary_net.currency || "EUR"} net`
    : (v.salary_gross ? `${v.salary_gross.min}–${v.salary_gross.max} ${v.salary_gross.currency || "EUR"} gross` : "по договорённости");

  const acc = v.accommodation
    ? (v.accommodation.provided
        ? (v.accommodation.cost_per_month ? `да, ~${v.accommodation.cost_per_month}/мес` : "да")
        : "нет")
    : "уточняется";

  const transport = v.transport_to_work === true ? "да" : (v.transport_to_work === false ? "нет" : "уточняется");
  const meals = v.meals_provided === true ? "да" : (v.meals_provided === false ? "нет" : "уточняется");

  const lines = [
    `• Страна: ${v.country || "-"}`,
    v.company ? `• Компания: ${v.company}${v.city ? `, ${v.city}` : ""}` : (v.city ? `• Город: ${v.city}` : null),
    v.position ? `• Позиция: ${v.position}` : null,
    v.hours_per_month ? `• Часы/мес: ${v.hours_per_month}` : null,
    v.schedule ? `• График: ${v.schedule}` : null,
    `• Зарплата: ${sal}`,
    `• Жильё: ${acc}`,
    `• Транспорт до работы: ${transport}`,
    `• Питание: ${meals}`,
    v.notes ? `• Примечание: ${v.notes}` : null,
  ].filter(Boolean);

  return lines.join("\n");
}

function formatPriceBlock(pricingObj, countryCode, positionKeyOrName) {
  if (!pricingObj) return null;

  // Иерархия: pricing.by_position > pricing.service_fee[country]
  let lines = [];

  // by_position (приоритет)
  if (pricingObj.by_position) {
    const posList = Object.keys(pricingObj.by_position);
    // попытка маппинга: warehouse -> warehouse, welder -> welder
    const key = (positionKeyOrName || "").toLowerCase();
    const exact = posList.find(p => p.toLowerCase() === key) ||
                  posList.find(p => p.toLowerCase() === (positionKeyOrName||"").toLowerCase());
    if (exact) {
      const fees = pricingObj.by_position[exact];
      lines.push(`• Стоимость услуг (${exact}):`);
      for (const k of Object.keys(fees)) {
        lines.push(`   – ${k}: ${fees[k]}`);
      }
    }
  }

  // service_fee по стране
  if (pricingObj.service_fee && countryCode && pricingObj.service_fee[countryCode.toLowerCase()]) {
    const fees = pricingObj.service_fee[countryCode.toLowerCase()];
    lines.push(`• Базовые услуги (${countryCode}):`);
    for (const k of Object.keys(fees)) {
      lines.push(`   – ${k}: ${fees[k]}`);
    }
  }

  return lines.length ? lines.join("\n") : null;
}

// ─────────────────────────────────────────────────────────────
// Поиск вакансий и сбор ответа
// ─────────────────────────────────────────────────────────────
function findMatches({ catalog, country, companyName, positionKey }) {
  let list = catalog.vacancies || [];

  if (country) {
    list = list.filter(v => (v.country || "").toUpperCase() === country.toUpperCase());
  }

  if (companyName) {
    list = list.filter(v => norm(v.company || "").includes(norm(companyName)));
  }

  if (positionKey) {
    // фильтруем по синонимам или точному совпадению позиции
    list = list.filter(v => {
      const vp = norm(v.position || "");
      if (!vp) return false;
      // прямая проверка ключа в названии
      if (vp.includes(positionKey)) return true;
      // по известным синонимам
      const syn = POSITION_SYNONYMS[positionKey] || [];
      return syn.some(s => vp.includes(s));
    });
  }

  return list;
}

function pickTop(list, n = 2) {
  return list.slice(0, n);
}

function listCompaniesInCountry(list) {
  const set = new Set();
  for (const v of list) {
    if (v.company) set.add(v.company);
  }
  return Array.from(set);
}

function listPositionsInCountry(list) {
  const set = new Set();
  for (const v of list) {
    if (v.position) set.add(v.position);
  }
  return Array.from(set);
}

// ─────────────────────────────────────────────────────────────
// Публичный API: попытка ответить из каталога
// ─────────────────────────────────────────────────────────────
export async function findCatalogAnswer(rawText, userLang = "ru") {
  const catalog = loadCatalog();
  const text = norm(rawText);

  // 1) Определяем страну/позицию/компанию
  const country = detectCountry(text); // "CZ" / "PL" / ...
  const positionKey = detectPosition(text); // "warehouse" / "welder" ...
  const companies = (catalog.vacancies || [])
    .map(v => v.company)
    .filter(Boolean);
  const companyName = detectCompany(text, companies);

  // 2) Если есть очевидный вопрос "что есть в <стране>" / "какие вакансии в ..."
  const asksWhat = /что (есть|доступно)|какие вакансии|what (do you have|positions)|available/i.test(rawText);

  // 3) Фильтруем подходящие вакансии
  let matches = findMatches({ catalog, country, companyName, positionKey });

  // 4) Если ничего не нашли — но указана страна — вернём список позиций/компаний
  if (!matches.length && country) {
    const byCountry = (catalog.vacancies || []).filter(v => (v.country || "").toUpperCase() === country.toUpperCase());
    if (byCountry.length) {
      const posList = listPositionsInCountry(byCountry);
      const compList = listCompaniesInCountry(byCountry);
      const header = `По ${country} сейчас доступны направления:`;
      const lines = [
        header,
        posList.length ? `• Позиции: ${posList.join(", ")}` : null,
        compList.length ? `• Компании: ${compList.join(", ")}` : null,
        "",
        "Скажите, какая позиция или компания интересует — пришлю детали и цены.",
      ].filter(Boolean);
      return { answer: lines.join("\n"), meta: { country, mode: "country_overview" } };
    }
  }

  // 5) Если нашли много — покажем топ-2 + подсказку уточнить
  if (matches.length >= 3 || (matches.length >= 2 && !companyName && !positionKey)) {
    const top = pickTop(matches, 2);
    const blocks = top.map(formatVacancy);
    const msg =
`Нашёл несколько вариантов${country ? ` по ${country}` : ""}${companyName ? ` (компания: ${companyName})` : ""}${positionKey ? ` (позиция: ${positionKey})` : ""}:

${blocks.join("\n\n")}

Хочешь подробнее по одной из компаний/позиций — скажи её название.`;
    return { answer: msg, meta: { country, companyName, positionKey, total: matches.length, mode: "multi" } };
  }

  // 6) Один точный матч — даём полный ответ + блок цен, если есть
  if (matches.length === 1) {
    const v = matches[0];
    const block = formatVacancy(v, userLang);
    const priceBlock = formatPriceBlock(catalog.pricing, v.country, v.position || positionKey);
    const msg =
`${block}
${priceBlock ? ("\n" + priceBlock) : ""}

Если подходит — продолжим: пришлю список документов и стартуем регистрацию.`;
    return { answer: msg, meta: { country: v.country, companyName: v.company || null, position: v.position || positionKey, mode: "single" } };
  }

  // 7) Ничего не найдено — но явный запрос по вакансиям
  if (asksWhat) {
    const allCountries = Array.from(new Set((catalog.vacancies || []).map(v => v.country).filter(Boolean)));
    if (allCountries.length) {
      return {
        answer: `Сейчас доступны вакансии в странах: ${allCountries.join(", ")}.\nНапишите страну и позицию (например: «Чехия склад»), пришлю конкретику: зарплаты, график, жильё и стоимость услуг.`,
        meta: { mode: "countries_overview" }
      };
    }
  }

  // 8) Если есть pricing, но нет вакансий — можно вернуть только цены по стране
  if (catalog.pricing && country) {
    const onlyPrice = formatPriceBlock(catalog.pricing, country, positionKey);
    if (onlyPrice) {
      return {
        answer: `Актуальные услуги по ${country}:\n${onlyPrice}\n\nСкажите позицию/компанию — пришлю детали вакансий.`,
        meta: { country, mode: "country_pricing_only" }
      };
    }
  }

  // Нет уверенного ответа из каталога
  return null;
}

// ─────────────────────────────────────────────────────────────
// Усиление ответа на возражение "дорого" фактами каталога
// ─────────────────────────────────────────────────────────────
export async function enrichExpensiveAnswer(baseText, userLang = "ru") {
  const catalog = loadCatalog();
  const vac = Array.isArray(catalog.vacancies) ? catalog.vacancies : [];

  if (!vac.length) return baseText;

  // Соберём ориентиры по CZ и общие
  const byCountry = vac.reduce((acc, v) => {
    const c = (v.country || "").toUpperCase();
    if (!c) return acc;
    acc[c] = acc[c] || [];
    acc[c].push(v);
    return acc;
  }, {});

  function rangeText(list) {
    let min = Infinity, max = -Infinity, cur = "EUR";
    for (const v of list) {
      const s = v.salary_net || v.salary_gross;
      if (!s) continue;
      if (typeof s.min === "number") min = Math.min(min, s.min);
      if (typeof s.max === "number") max = Math.max(max, s.max);
      if (s.currency) cur = s.currency;
    }
    if (!isFinite(min) || !isFinite(max)) return null;
    return `${min}–${max} ${cur}`;
  }

  const czRange = byCountry.CZ ? rangeText(byCountry.CZ) : null;
  const allRange = rangeText(vac) || null;

  // Возьмём средний по жилью (если указан)
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

  const extraLines = [];
  if (czRange) extraLines.push(`• Чехия: чистыми обычно ${czRange}`);
  else if (allRange) extraLines.push(`• По нашим проектам: чистыми ${allRange}`);

  if (czAcc) extraLines.push(`• Жильё в CZ ≈ ${czAcc}/мес (если не бесплатно у работодателя)`);

  if (!extraLines.length) return baseText;

  const tail =
`\n\n📌 Ориентиры по нашим проектам:\n${extraLines.join("\n")}
Если интересен старт с 1–2 кандидатами — пришлю счёт и чек-лист документов.`;

  return baseText + tail;
}
