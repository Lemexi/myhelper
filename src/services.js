// /src/services.js
import fs from "fs";
import path from "path";

const catalogPath = path.resolve("./src/catalog.json");

function loadCatalog() {
  try {
    const raw = fs.readFileSync(catalogPath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("Error loading catalog:", err);
    return null;
  }
}

function findVacancyAnswer(userText, userLang = "en") {
  const catalog = loadCatalog();
  if (!catalog) return null;

  const text = userText.toLowerCase();

  const countries = {
    cz: ["cz", "czech", "czechia", "чех", "чеська", "чехія"],
    pl: ["pl", "poland", "поль", "польша", "польща"],
    rs: ["rs", "serbia", "серб", "сербія"]
  };

  let matchedCountry = null;
  for (const [code, variants] of Object.entries(countries)) {
    if (variants.some(v => text.includes(v))) {
      matchedCountry = code.toUpperCase();
      break;
    }
  }

  if (!matchedCountry) return null;

  const activeVacancies = catalog.vacancies.filter(v => v.active && v.country === matchedCountry);
  if (!activeVacancies.length) return `Сейчас нет активных вакансий в ${matchedCountry}.`;

  const sample = activeVacancies[0];

  const url = catalog.country_pages[matchedCountry];

  const answer = [
    `📍 *${sample.position}*, ${sample.city} (${sample.company})`,
    `💼 ${sample.salary_text || "Salary TBD"}`,
    `📅 Период: ${sample.employment_period || "TBD"}`,
    sample.accommodation?.provided
      ? `🏠 Проживание: предоставляется, ${sample.accommodation.note}`
      : `🏠 Проживание: не предоставляется`,
    `📎 Подробнее: ${url?.demand || "https://renovogo.com"}`
  ];

  return answer.join("\n");
}

export { findVacancyAnswer };
