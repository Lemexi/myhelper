// /src/orchestrator.js

/**
 * Оркестратор — определяет следующий шаг диалога
 * Работает "в тени": хранит чекпоинты, но не делает из них сухую анкету.
 */

import { getCatalogSnapshot } from "./services.js";

/* ───────────────── Типовые чекпоинты ───────────────── */
const REQUIRED_FIELDS = [
  "role",        // агент / клиент
  "country",     // страна интереса (CZ/PL/…)
  "position",    // должность / вакансия
  "candidates",  // количество кандидатов (если агент)
  "conditions"   // ключевые условия (ставка, жильё, часы)
];

/* ───────────────── Вспомогательные ───────────────── */
function needsField(meta, field) {
  return !(meta && meta.profile && meta.profile[field]);
}

function buildQuestion(field) {
  switch (field) {
    case "role":
      return "Подскажите, пожалуйста, вы ищете работу лично для себя или представляете кандидатов как агент?";
    case "country":
      return "В какой стране для вас актуальны вакансии — Чехия, Польша или другая?";
    case "position":
      return "Какая именно должность или направление работы вас интересует?";
    case "candidates":
      return "Сколько кандидатов вы рассматриваете для трудоустройства?";
    case "conditions":
      return "Какие условия для вас самые важные (ставка net, жильё, график)?";
    default:
      return null;
  }
}

/* ───────────────── Решение следующего шага ───────────────── */
export async function decideNextStep({ session, text, snapshot }) {
  const meta = (session && (session.meta_json || {})) || {};
  const profile = meta.profile || {};
  const turnNo = (meta.turn_no || 0) + 1;

  // 1) Проверка оффтопа — если далеко от темы, отвечаем, но планируем мягкий возврат
  const isOffTopic =
    /\b(погода|машин|авто|колес|давление|новости|футбол)\b/i.test(text);

  if (isOffTopic) {
    return {
      blockCatalog: true,
      nudgeEN: "Кстати, чтобы подобрать для вас вакансии, мне нужно уточнить пару деталей о вашей ситуации.",
      metaPatch: { turn_no: turnNo }
    };
  }

  // 2) Определяем, каких данных не хватает
  const missing = REQUIRED_FIELDS.filter(f => needsField(meta, f));

  if (missing.length) {
    const nextField = missing[0];

    // если критичный вопрос (role или country) → задаём напрямую
    if (nextField === "role" || nextField === "country") {
      return {
        questionEN: buildQuestion(nextField),
        metaPatch: { turn_no: turnNo }
      };
    }

    // если менее критично → можно подождать, но мягко подтолкнуть каждые 3–4 хода
    if (turnNo % 3 === 0) {
      return {
        nudgeEN: buildQuestion(nextField),
        metaPatch: { turn_no: turnNo }
      };
    }
  }

  // 3) Когда все ключевые поля собраны — можем использовать каталог
  if (!missing.length) {
    return {
      allowCatalog: true,
      metaPatch: { turn_no: turnNo, ready: true }
    };
  }

  // 4) Иначе — просто продолжаем свободный диалог
  return { metaPatch: { turn_no: turnNo } };
}