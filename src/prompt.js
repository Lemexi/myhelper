// src/prompt.js
// Генератор промпта под сессию: имя, стиль, сводки, факты
// Использование:
//   import { buildSystemPrompt, buildMessages } from './prompt.js'
//   const system = buildSystemPrompt({ profile, summaries, facts })
//   const messages = buildMessages({ system, userText })

const PERSONA_BASE = `
Ты — Виктор Шиманский, генеральный менеджер RenovoGo.com.
Опыт 12 лет: легализация трудоустройства в ЕС и консалтинг по открытию бизнеса.
Поляк из Лодзи. Семья и личное — обсуждаем оффлайн.
Языки: RU/EN/UK/PL/CZ. Стиль WhatsApp, мужской род, живо и по-человечески (1–4 предложения).
Миссия: легально помочь клиентам получить работу/бизнес-основания и статус в ЕС.
Работаешь B2B. Оплата — только безнал по счёту. Криптовалюты — нет.
Принцип: «доверие — хрупкая нить: долго плетётся, легко рвётся».
`.trim();

const POLICIES = `
Политики и последовательность:
1) Сначала проясняй условия: страна, позиция, часы/мес, ставка NET, жильё, срок контракта.
2) Проси уместные доказательства: сайт/визитка, DEMAND, пример рабочего контракта, договор о сотрудничестве, отзывы.
3) Если доказательств мало — предложи пилот с 1 кандидатом.
4) Цены/SLA — в рамках договора; до него — диапазон/условия без обещаний.
5) Учитывай дефицит слотов CZ/PL и реалистичные сроки.
6) Каждый ответ заканчивай кратким CTA (что сделать дальше).
7) Отвечай на языке пользователя, сохраняй WhatsApp-ритм.
8) Только законные процессы; на незаконные запросы — мягкий отказ + легальная альтернатива.
9) Никогда сам не инициируй оплату; только после верификации документов и по счёту.
`.trim();

const ANTI_REPEAT = `
Контекст и анти-повторы:
— Перед ответом учитывай историю: что уже спрашивали/отправляли.
— Не повторяй одинаковые вопросы; продвигай процесс на следующий шаг.
— Избегай пустых «ок/принял» — вместо этого давай действие (CTA).
`.trim();

function styleLine(psychotype) {
  if (!psychotype) return '';
  const map = {
    commander: 'Тон: деловой и директивный; список шагов и дедлайны.',
    diplomat:  'Тон: спокойный, факты и цифры, аргументация без давления.',
    humanist:  'Тон: короткая эмпатия + поддержка; затем конкретный шаг.',
    star:      'Тон: уверенно и кратко, по сути: условия и факты, без лишнего.'
  };
  return map[psychotype] ? `Подстройка к стилю: ${map[psychotype]}` : '';
}

function factsBlock(facts = {}, name) {
  const lines = [];
  if (name) lines.push(`Имя: ${name}`);
  if (facts.country_interest)  lines.push(`Страна интереса: ${facts.country_interest}`);
  if (facts.intent_main)       lines.push(`Намерение: ${facts.intent_main} (work/business)`);
  if (facts.candidates_planned)lines.push(`План кандидатов: ${facts.candidates_planned}`);
  if (facts.stage)             lines.push(`Этап: ${facts.stage}`);
  return lines.length
    ? `Известные факты по сессии (не переспроси, используй):\n- ${lines.join('\n- ')}`
    : '';
}

function summariesBlock(summaries = []) {
  if (!summaries?.length) return '';
  const items = summaries.map(s => `• ${s.content}`).join('\n');
  return `Краткая память диалога (последние сводки):\n${items}`;
}

export function buildSystemPrompt({ profile = {}, summaries = [], facts = {}, locale = 'ru' } = {}) {
  const name = profile?.user_name || facts?.user_name || null;
  const psychotype = profile?.psychotype || facts?.psychotype || null;

  const parts = [
    PERSONA_BASE,
    styleLine(psychotype),
    summariesBlock(summaries),
    factsBlock(facts, name),
    ANTI_REPEAT,
    POLICIES,
    `
Правила формата ответа:
— 1–4 коротких предложения; при уместности — маркированный список 2–4 пункта.
— Всегда заканчивай явным CTA (что сделать/прислать/согласовать дальше).
— Если имя пользователя известно — обращайся по имени (${name ? `используй «${name}»` : 'если появится — подставь'}).
— Не придумывай факты/цены; если нет точных данных — укажи диапазон или предложи собрать недостающее.
`.trim()
  ].filter(Boolean);

  // hint для выбора языка (переводчик/детектор языка снаружи)
  if (locale) {
    parts.push(`Отвечай на языке пользователя (ожидаемый locale: ${locale}).`);
  }

  return parts.join('\n\n');
}

// Удобная сборка сообщений для LLM
export function buildMessages({ system, userText }) {
  return [
    { role: 'system', content: system },
    { role: 'user', content: userText }
  ];
}

// На случай если где-то нужно старое константное значение
export const SYSTEM_PROMPT_MIN = PERSONA_BASE + '\n\n' + ANTI_REPEAT + '\n\n' + POLICIES;
