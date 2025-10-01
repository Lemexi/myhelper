// /src/reply.js
import { SYSTEM_PROMPT } from "./prompt.js";
import {
  upsertSession, updateContact, saveMessage, loadRecentMessages,
  loadLatestSummary, logReply, getLastAuditCategory, getSession
} from "./db.js";
import { kbFind, kbInsertAnswer } from "./kb.js";
import {
  translateCached, translateWithStyle,
  toEnglishCanonical, detectLanguage
} from "./translator.js";
import {
  classifyCategory, detectAnyName, detectPhone,
  isCmdTeach, parseCmdTeach,
  isCmdTranslate, parseCmdTranslate,
  isCmdAnswerExpensive, extractGreeting
} from "./classifier.js";
import { runLLM } from "./llm.js";

// Каталог — факты только из catalog.json
import { findCatalogAnswer, getCatalogSnapshot } from "./services.js";

/* ────────────────────────────────────────────────────────────
 * БЛОК 1. КОНСТАНТЫ И ФЛАГИ
 * ──────────────────────────────────────────────────────────── */

// Категории, где ИСКЛЮЧИТЕЛЬНО каталог, без LLM
const CATALOG_CATS = new Set([
  "vacancies", "jobs", "catalog", "positions", "countries_overview", "vacancy_detail"
]);

// Интент "гарантии/доверие" — для ANSWER-FIRST
const RE_INTENT_GUARANTEE = /(гарант|безопас|довер|обман|мошенн|scam|fraud|guarantee|trust|verify|legality|legal)/i;

/* ────────────────────────────────────────────────────────────
 * БЛОК 2. ХЕЛПЕРЫ И ДЕТЕКТОРЫ
 * ──────────────────────────────────────────────────────────── */

function shouldUseCatalog(raw) {
  const t = String(raw || "").toLowerCase();

  const vacancySignals = [
    "ваканс", "позици", "какие есть", "что доступно", "что у вас есть",
    "список", "каталог", "доступные", "должност", "направлени",
    "available positions", "what do you have", "what positions",
    "countries available", "open countries",
    "польша", "чехи", "серби", "литв", "латв", "estoni", "герман", "slovak", "romani", "poland", "czech", "serbia", "lithuania", "latvia"
  ];

  // Если текст явным образом про оплату/партнёрство — даём шанс другим веткам
  const blockIf = [
    "оплат", "платеж", "счёт", "инвойс", "виза", "гаранти", // гаранти попадает под RE_INTENT_GUARANTEE
    "partner", "партнер", "партнёр", "b2b", "сотруднич", "условия оплаты"
  ];

  if (blockIf.some(w => t.includes(w))) return false;
  return vacancySignals.some(w => t.includes(w));
}

function isNameInquiry(raw) {
  const t = String(raw || "").toLowerCase();
  return /(как\s+вас\s+зовут|как\s+к\s+вам\s+обращаться|your\s+name)/i.test(t);
}

/* ────────────────────────────────────────────────────────────
 * БЛОК 3. LLM FALLBACK (Answer-first логика живёт выше в роутере)
 * ──────────────────────────────────────────────────────────── */

async function replyCore(sessionId, userTextEN) {
  const recentRaw = await loadRecentMessages(sessionId, 24);
  const recent = (recentRaw || [])
    .map(m => ({ role: m.role, content: String(m.content ?? "") }))
    .filter(m => m.role && m.content);

  const summary = await loadLatestSummary(sessionId);

  const messages = [];
  messages.push({ role: "system", content: SYSTEM_PROMPT });
  if (summary) {
    messages.push({
      role: "system",
      content: `Краткая сводка прошлой истории:\n${summary}`
    });
  }
  messages.push(...recent);
  messages.push({ role: "user", content: userTextEN });

  const safe = messages.map(m => ({ role: m.role, content: m.content }));
  const { text } = await runLLM(safe);
  return text;
}

/* ────────────────────────────────────────────────────────────
 * БЛОК 4. ПРИВЕТСТВИЕ
 * ──────────────────────────────────────────────────────────── */

function namePleasantry(lang, name) {
  if (!name) return "";
  const by = {
    ru: `Очень приятно познакомиться, ${name}. `,
    uk: `Дуже приємно познайомитися, ${name}. `,
    pl: `Miło mi poznać, ${name}. `,
    cz: `Těší mě, ${name}. `,
    en: `Nice to meet you, ${name}. `
  };
  return by[lang] || by.en;
}

function greetingWithName(lang, name) {
  if (!name) {
    return {
      ru: "Здравствуйте. ",
      uk: "Вітаю. ",
      pl: "Dzień dobry. ",
      cz: "Dobrý den. ",
      en: "Hello. "
    }[lang] || "Hello. ";
  }
  return {
    ru: `Здравствуйте, ${name}! `,
    uk: `Вітаю, ${name}! `,
    pl: `Dzień dobry, ${name}! `,
    cz: `Dobrý den, ${name}! `,
    en: `Hello, ${name}! `
  }[lang] || `Hello, ${name}! `;
}

function buildWarmIntro(userLang = "ru", knownName = null) {
  const greet = greetingWithName(userLang, knownName);
  const nice  = namePleasantry(userLang, knownName);

  const by = {
    ru: `${greet}Меня зовут Виктор Шиманский, я генеральный менеджер Renovogo.com. Спасибо, что обратились к нам. ${nice}Чем я могу вам помочь?`,
    uk: `${greet}Мене звати Віктор Шиманський, я генеральний менеджер Renovogo.com. Дякую, що звернулися до нас. ${nice}Чим я можу допомогти?`,
    pl: `${greet}Nazywam się Wiktor Szymański, jestem general managerem w Renovogo.com. Dziękuję za kontakt. ${nice}W czym mogę pomóc?`,
    cz: `${greet}Jmenuji se Viktor Szymanski, jsem generální manažer Renovogo.com. Děkuji za zprávu. ${nice}S čím mohu pomoci?`,
    en: `${greet}I’m Viktor Szymanski, General Manager at Renovogo.com. Thanks for reaching out. ${nice}How can I help?`
  };

  return by[userLang] || by.en;
}

/* ────────────────────────────────────────────────────────────
 * БЛОК 5. ОБРАБОТЧИКИ КОМАНД
 * ──────────────────────────────────────────────────────────── */

async function handleCmdTranslate(sessionId, rawText, userLang = "ru") {
  const { targetLangWord, text } = parseCmdTranslate(rawText);
  const targetLang = (targetLangWord || "en").toLowerCase();

  if (!text || text.length < 2) {
    const msg = "Нужен текст после команды «Переведи».";
    const { canonical } = await toEnglishCanonical(msg);
    await saveMessage(
      sessionId, "assistant", canonical,
      { category: "translate", strategy: "cmd_translate_error" },
      "en", userLang, msg, "translate"
    );
    return msg;
  }

  const { targetLang: tgt, styled, styledRu } =
    await translateWithStyle({ sourceText: text, targetLang });

  const combined =
`🔍 Перевод (${tgt.toUpperCase()}):
${styled}

💬 Для тебя (RU):
${styledRu}`;

  const { canonical } = await toEnglishCanonical(combined);
  await saveMessage(
    sessionId, "assistant", canonical,
    { category: "translate", strategy: "cmd_translate" },
    "en", userLang, combined, "translate"
  );

  return combined;
}

async function handleCmdTeach(sessionId, rawText, userLang = "ru") {
  const taught = parseCmdTeach(rawText);
  if (!taught) {
    const msg = "Нужен текст после «Ответил бы».";
    const { canonical } = await toEnglishCanonical(msg);
    await saveMessage(
      sessionId, "assistant", canonical,
      { category: "teach", strategy: "cmd_teach_error" },
      "en", userLang, msg, "teach"
    );
    return msg;
  }
  const lastCat = (await getLastAuditCategory(sessionId)) || "general";
  const kbId = await kbInsertAnswer(lastCat, userLang || "ru", taught, true);

  const out = `✅ В базу добавлено.\n\n${taught}`;
  const { canonical } = await toEnglishCanonical(out);
  await saveMessage(
    sessionId, "assistant", canonical,
    { category: lastCat, strategy: "cmd_teach", kb_id: kbId },
    "en", userLang, out, lastCat
  );
  return out;
}

async function handleCmdAnswerExpensive(sessionId, userLang = "ru") {
  const kb = (await kbFind("expensive", userLang)) || (await kbFind("expensive", "ru"));
  let answer;
  if (kb?.answer) {
    answer = userLang !== "ru"
      ? (await translateCached(kb.answer, "ru", userLang)).text
      : kb.answer;
  } else {
    answer = await replyCore(
      sessionId,
      "Client says it's expensive. Give a brief WhatsApp-style response with value framing and a clear CTA."
    );
  }
  const { canonical } = await toEnglishCanonical(answer);
  await saveMessage(
    sessionId, "assistant", canonical,
    { category: "expensive", strategy: "cmd_answer_expensive" },
    "en", userLang, answer, "expensive"
  );
  await logReply(sessionId, "cmd", "expensive", kb?.id || null, null, "trigger: answer expensive");
  return answer;
}

/* ────────────────────────────────────────────────────────────
 * БЛОК 6. SMART REPLY — ГЛАВНЫЙ РОУТЕР
 * ──────────────────────────────────────────────────────────── */

export async function smartReply(sessionKey, channel, userTextRaw, userLangHint = "ru") {
  const sessionId = await upsertSession(sessionKey, channel);

  // Канонизируем вход
  const { canonical: userTextEN, sourceLang: srcLang, original: origText } =
    await toEnglishCanonical(userTextRaw);
  const userLang = srcLang || userLangHint;

  // Имя / телефон (обновляем контакт тихо)
  const nameInThisMsg = detectAnyName(userTextRaw);
  const phone = detectPhone(userTextRaw);
  if (nameInThisMsg || phone) await updateContact(sessionId, { name: nameInThisMsg, phone });

  // Это первый ответ ассистента?
  const recentRaw = await loadRecentMessages(sessionId, 4);
  const noAssistantYet = !(recentRaw || []).some(m => m.role === "assistant");

  // Сохраняем вход пользователя
  const userMsgId = await saveMessage(
    sessionId, "user", userTextEN,
    null, "en", userLang, origText, null
  );

  // Если пользователь спросил имя → ответим сразу
  if (isNameInquiry(userTextRaw)) {
    const intro = buildWarmIntro(userLang, null);
    const { canonical } = await toEnglishCanonical(intro);
    await saveMessage(
      sessionId, "assistant", canonical,
      { category: "intro", strategy: "name_inquiry" },
      "en", userLang, intro, "intro"
    );
    return intro;
  }

  // Команды
  if (isCmdTeach(userTextRaw)) {
    const out = await handleCmdTeach(sessionId, userTextRaw, userLang);
    await logReply(sessionId, "cmd", "teach", null, userMsgId, "trigger: teach");
    return out;
  }

  if (isCmdTranslate(userTextRaw)) {
    const { text: t } = parseCmdTranslate(userTextRaw);
    if (t && t.length >= 2) {
      const out = await handleCmdTranslate(sessionId, userTextRaw, userLang);
      await logReply(sessionId, "cmd", "translate", null, userMsgId, "trigger: translate");
      return out;
    }
  }

  if (isCmdAnswerExpensive(userTextRaw)) {
    const out = await handleCmdAnswerExpensive(sessionId, userLang);
    await logReply(sessionId, "cmd", "expensive", null, userMsgId, "trigger: answer expensive");
    return out;
  }

  // Тёплое персональное приветствие (только первый ответ)
  if (noAssistantYet) {
    const session = await getSession(sessionId);
    const knownName = nameInThisMsg || session?.user_name?.trim() || null;

    let outText = buildWarmIntro(userLang, knownName);

    // Если первый вход уже про вакансии — добавим тизер каталога (без LLM)
    if (shouldUseCatalog(userTextRaw)) {
      try {
        const teaserRes = await findCatalogAnswer(userTextRaw, userLang);
        const teaser = teaserRes && typeof teaserRes === "object" ? teaserRes.answer : teaserRes;
        if (teaser && teaser.trim()) {
          outText = `${outText}\n\n${teaser}`;
        }
      } catch {
        // молча игнорируем и шлём только приветствие
      }
    }

    const { canonical } = await toEnglishCanonical(outText);
    await saveMessage(
      sessionId, "assistant", canonical,
      { category: "intro", strategy: "warm_intro" },
      "en", userLang, outText, "intro"
    );
    return outText;
  }

  // ── ANSWER-FIRST: прямые вопросы про гарантии/легальность
  if (RE_INTENT_GUARANTEE.test(userTextRaw)) {
    const ans = {
      ru: [
        "Работаем только легально: официальный договор с работодателем и договор о сотрудничестве, реквизиты проверяемы.",
        "Оплата по счёту — после проверки документов и согласования условий.",
        "Шаблоны и чек-лист доступны на сайте по странам.",
        "Предлагаю старт с пилота на 1–2 кандидата, чтобы вы увидели процесс; с какой страны начнём?"
      ].join(" "),
      en: [
        "We work only legally: employer contract + cooperation agreement, verifiable details.",
        "Payment by invoice after document checks and agreed terms.",
        "Templates and checklist are available on our site by country.",
        "Let’s start with a 1–2 candidate pilot so you can see the process; which country suits you to start?"
      ].join(" ")
    };
    const text = userLang === "ru" ? ans.ru : ans.en;
    const { canonical } = await toEnglishCanonical(text);
    await saveMessage(
      sessionId, "assistant", canonical,
      { category: "guarantee", strategy: "answer_first" },
      "en", userLang, text, "guarantee"
    );
    return text;
  }

  // Интент от классификатора
  const category = await classifyCategory(userTextRaw);

  // ── Жёсткий guard: всё про вакансии/страны/позиции — только каталог (никакого LLM)
  const useCatalog = CATALOG_CATS.has(category) || shouldUseCatalog(userTextRaw);
  if (useCatalog) {
    try {
      const res = await findCatalogAnswer(userTextRaw, userLang);
      const out = res && typeof res === "object" ? res.answer : res;
      if (out && out.trim()) {
        let text = out;
        const detected = await detectLanguage(text);
        if (detected !== userLang) {
          text = (await translateCached(text, detected, userLang)).text;
        }
        const { canonical } = await toEnglishCanonical(text);
        await logReply(sessionId, "services_hint", "catalog", null, userMsgId, null);
        await saveMessage(
          sessionId, "assistant", canonical,
          { category: "catalog", strategy: "services_hint" },
          "en", userLang, text, "catalog"
        );
        return text;
      }

      // Каталог ответил пусто → корректный дефолт без LLM
      const snap = getCatalogSnapshot();
      const opts = (snap.openCountries || []).join(", ");
      const safe = opts
        ? `Сейчас открыты направления: ${opts}. Назовите страну и позицию — вышлю условия и чек-лист.`
        : "Набор временно закрыт. Могу поставить вас в приоритет и уведомить об открытии.";
      const { canonical } = await toEnglishCanonical(safe);
      await saveMessage(
        sessionId, "assistant", canonical,
        { category: "catalog", strategy: "catalog_snapshot" },
        "en", userLang, safe, "catalog"
      );
      return safe;

    } catch (e) {
      // Ошибка сервиса — даём безопасный дефолт и выходим (никакого LLM по вакансиям)
      await logReply(sessionId, "services_error", "catalog", null, userMsgId, String(e?.message || e));
      const fallback = "Понимаю. Напишите страну и позицию — проверю доступность и пришлю условия.";
      const { canonical } = await toEnglishCanonical(fallback);
      await saveMessage(
        sessionId, "assistant", canonical,
        { category: "catalog", strategy: "catalog_guard_fallback" },
        "en", userLang, fallback, "catalog"
      );
      return fallback;
    }
  }

  // ── KB → перевод → LLM (общие темы, не каталог)
  let kb = await kbFind(category, userLang);
  let answer, strategy = "fallback_llm", kbItemId = null;

  if (kb) {
    answer = kb.answer;
    strategy = "kb_hit";
    kbItemId = kb.id;
  } else {
    const kbRu = await kbFind(category, "ru");
    if (kbRu) {
      answer = (await translateCached(kbRu.answer, "ru", userLang)).text;
      strategy = "kb_translated";
      kbItemId = kbRu.id;
    }
  }

  if (!answer) {
    answer = await replyCore(sessionId, userTextEN);
    const detectedLLM = await detectLanguage(answer);
    if (detectedLLM !== userLang) {
      answer = (await translateCached(answer, detectedLLM, userLang)).text;
    }
  }

  const { canonical: ansEN } = await toEnglishCanonical(answer);
  await logReply(sessionId, strategy, category, kbItemId, userMsgId, null);
  await saveMessage(
    sessionId, "assistant", ansEN,
    { category, strategy },
    "en", userLang, answer, category
  );

  return answer;
}
