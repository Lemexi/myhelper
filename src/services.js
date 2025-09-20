// /src/services.js
// Отдаём КОРОТКИЕ тизеры по вакансиям/странам/ценам ТОЛЬКО при явном интенте.
// Полные блоки — только если пользователь просит "подробнее/детально/полные условия".

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const CATALOG_PATH = path.join(__dirname, "catalog.json");

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

function norm(t) { return String(t || "").toLowerCase().replace(/\s+/g, " ").trim(); }
function includesAny(t, arr) { return arr.some(w => t.includes(w)); }

// ── Детекторы ──
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

function getAvailableCountries(catalog) {
  const set = new Set();
  for (const v of (catalog.vacancies || [])) if (v.active) set.add((v.country || "").toUpperCase());
  return Array.from(set);
}

// ── Форматтеры ──
function formatSalaryShort(v) {
  if (v.salary_text) return v.salary_text;
  const s = v.salary_net || v.salary_gross;
  if (s && typeof s.min === "number") {
    const cur = s.currency || "EUR";
    return `from ${s.min} ${cur}${v.salary_net ? " net" : ""}`;
  }
  return "salary TBC";
}

function pickTop(list, n = 2) { return list.slice(0, n); }

// ── Сигналы интента для каталога ──
const VACANCY_WORDS = [
  "vacanc", "position", "role", "jobs", "available",
  "ваканси", "позици", "работа", "что есть по", "какие есть", "что доступно", "список", "каталог"
];
const DETAIL_WORDS = ["detail", "full", "terms", "подроб", "деталь", "полные", "чеклист"];
function hasAny(text, arr){ const t=norm(text); return arr.some(w => t.includes(w)); }

// ── ПУБЛИЧНО ──
export async function findCatalogAnswer(rawText, _userLang = "en") {
  const catalog = loadCatalog();
  const text = norm(rawText);
  const availableCountries = getAvailableCountries(catalog);
  const countryPages = catalog.country_pages || {};

  const country = detectCountry(text);
  const positionKey = detectPosition(text);
  const wantDetail = hasAny(text, DETAIL_WORDS);

  // 1) Не лезем, если нет явных сигналов про вакансии/позиции/каталог
  const hasVacancySignal = hasAny(text, VACANCY_WORDS) || !!country || !!positionKey;
  if (!hasVacancySignal) return null;

  // 2) Если страна указана, но закрыта — короткий ответ-навигатор
  if (country && !availableCountries.includes(country)) {
    const alt = availableCountries.length ? `Open now: ${availableCountries.join(", ")}.` : "Recruitment is temporarily closed.";
    const link = countryPages[country]?.demand ? `\nDocs page: ${countryPages[country].demand}` : "";
    return `The ${country} direction is closed right now. ${alt}${link}\nTell me which country you prefer — I’ll send options.`;
  }

  // 3) Без страны → только тизер по открытым направлениям (без простынь)
  if (!country) {
    if (!availableCountries.length) {
      return "Recruitment is temporarily closed. I can put you on priority and ping you on reopening.";
    }
    const perCountry = availableCountries.map(c => {
      const list = (catalog.vacancies || []).filter(v => v.active && (v.country || "").toUpperCase() === c);
      const top = pickTop(list, 2)
        .map(v => `${v.position} — ${formatSalaryShort(v)}`)
        .join("; ");
      const link = countryPages[c]?.demand ? ` (docs: ${countryPages[c].demand})` : "";
      return `${c}: ${top}${link}`;
    });
    return `Open now — ${perCountry.join(" | ")}.\nSay the country + position, and I’ll send full terms or a checklist.`;
  }

  // 4) Есть страна → краткие 1–2 варианта; полный блок только если просят «подробнее»
  let matches = (catalog.vacancies || []).filter(v => v.active && (v.country || "").toUpperCase() === country);
  if (positionKey) {
    matches = matches.filter(v => norm(v.position || "").includes(positionKey));
  }
  if (!matches.length) {
    const link = countryPages[country]?.demand ? `\nDocs page: ${countryPages[country].demand}` : "";
    return `In ${country} I can offer general warehouse/production roles${link ? "."+link : ""}\nTell me the exact role or company — I’ll send terms.`;
  }

  const top = pickTop(matches, 2);
  if (!wantDetail) {
    const line = top.map(v => `${v.company}: ${v.position} — ${formatSalaryShort(v)}`).join(" | ");
    const link = countryPages[country]?.demand ? ` (docs: ${countryPages[country].demand})` : "";
    return `${country}: ${line}${link}\nWant full terms for one company? Say “details for <company>”.`;
  }

  // 5) Полные условия — только по явному запросу
  const blocks = top.map(v => {
    const bits = [
      v.company && `• Company: ${v.company}${v.city ? `, ${v.city}` : ""}`,
      v.position && `• Position: ${v.position}`,
      `• Salary: ${formatSalaryShort(v)}`,
      v.accommodation?.cost_per_month != null && `• Accommodation: ~${v.accommodation.cost_per_month}/month`
    ].filter(Boolean).join("\n");
    return bits;
  }).join("\n\n");

  const link = countryPages[country]?.demand ? `\nDocs page: ${countryPages[country].demand}` : "";
  return `${blocks}${link}\nIf this fits, I’ll send the checklist and pricing per candidate.`;
}
