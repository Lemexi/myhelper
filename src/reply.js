// /src/reply.js

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

import { buildSystemPrompt, buildMessages } from "./prompt.js";
import { ensureName, upsertFacts, getSessionProfile } from "./memory.js";
import { fetchRecentSummaries } from "./summaries.js";
import { maybeUpdateStyle } from "./style.js";
import { saveUserQuestion, findAnswerFromKB } from "./qna.js";

/* ─────────────────────────────────────────────────────────────
 * ВСПОМОГАТЕЛЬНОЕ
 * ────────────────────────────────────────────────────────────*/

function buildAskName(userLang, rawText) {
  const hi = extractGreeting(rawText);
  const by = {
    ru: `${hi ? hi + ". " : ""}Подскажите, пожалуйста, как вас зовут, чтобы я знал, как к вам обращаться?`,
    uk: `${hi ? hi + ". " : ""}Підкажіть, будь ласка, як вас звати, щоб я знав, як до вас звертатися?`,
    pl: `${hi ? hi + ". " : ""}Proszę podpowiedzieć, jak ma Pan/Pani na imię, żebym wiedział, jak się zwracać?`,
    cz: `${hi ? hi + ". " : ""}Prosím, jak se jmenujete, ať vím, jak vás oslovovat?`,
    en: `${hi ? hi + ". " : ""}May I have your name so I know how to address you?`
  };
  return by[userLang] || by.en;
}

async function llmFallbackReply(sessionId, userTextEN, lang, promptExtras = {}) {
  // история → безопасный формат
  const recentRaw = await loadRecentMessages(sessionId, 18);
  const recent = (recentRaw || [])
    .map(m => ({ role: m.role, content: String(m.content ?? "") }))
    .filter(m => m.role && m.content);

  // память
  const summaries = await fetchRecentSummaries(sessionId, 3);
  const profile   = await getSessionProfile(sessionId);
  const system    = buildSystemPrompt({
    profile,
    summaries,
    facts: {
      user_name: profile?.user_name,
      country_interest: profile?.country_interest,
      intent_main: profile?.intent_main,
      candidates_planned: profile?.candidates_planned,
      stage: profile?.stage,
      psychotype: profile?.psychotype,
      ...promptExtras
    },
    locale: lang
  });

  const msgs = buildMessages({ system, userText: userTextEN });
  // подмешиваем историю (до юзерского)
  const safe = [msgs[0], ...recent, msgs[1]].map(m => ({ role: m.role, content: m.content }));
  const { text } = await runLLM(safe);
  return text;
}

/* ─────────────────────────────────────────────────────────────
 * КОМАНДЫ
 * ────────────────────────────────────────────────────────────*/

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
    answer = await llmFallbackReply(
      sessionId,
      "Client says it's expensive. Give a brief WhatsApp-style response with value framing and a clear CTA.",
      userLang
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

/* ─────────────────────────────────────────────────────────────
 * КАТЕГОРИАЛЬНЫЙ РОУТЕР (легко расширять)
 * ────────────────────────────────────────────────────────────*/

async function routeByCategory({ category, sessionId, userLang, userTextEN, userMsgId }) {
  // 1) Точная база QnA (совпадение вопроса)
  const kbExact = await findAnswerFromKB(userTextEN, 0.9);
  if (kbExact) {
    const { canonical } = await toEnglishCanonical(kbExact);
    await logReply(sessionId, "kb_exact", category, null, userMsgId, "qna exact");
    await saveMessage(
      sessionId, "assistant", canonical,
      { category, strategy: "kb_exact" },
      "en", userLang, kbExact, category
    );
    return kbExact;
  }

  // 2) Категорийная KB
  let kb = await kbFind(category, userLang);
  let answer = null;
  let strategy = "fallback_llm";
  let kbItemId = null;

  if (kb?.answer) {
    answer = kb.answer;
    strategy = "kb_hit";
    kbItemId = kb.id;
  } else {
    const kbRu = await kbFind(category, "ru");
    if (kbRu?.answer) {
      answer = (await translateCached(kbRu.answer, "ru", userLang)).text;
      strategy = "kb_translated";
      kbItemId = kbRu.id;
    }
  }

  // 3) LLM
  if (!answer) {
    answer = await llmFallbackReply(sessionId, userTextEN, userLang);
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

/* ─────────────────────────────────────────────────────────────
 * SMART REPLY (главная точка)
 * ────────────────────────────────────────────────────────────*/

export async function smartReply(sessionKey, channel, userTextRaw, userLangHint = "ru", extra = {}) {
  const sessionId = await upsertSession(sessionKey, channel);

  // 0) Канонизация входа
  const { canonical: userTextEN, sourceLang: srcLang, original: origText } =
    await toEnglishCanonical(userTextRaw);
  const userLang = srcLang || userLangHint;

  // 1) Команды
  if (isCmdTeach(userTextRaw)) {
    const msgId = await saveMessage(
      sessionId, "user", userTextEN,
      { kind: "cmd_detected", cmd: "teach" },
      "en", userLang, origText, null
    );
    const out = await handleCmdTeach(sessionId, userTextRaw, userLang);
    await logReply(sessionId, "cmd", "teach", null, msgId, "trigger: teach");
    return out;
  }

  if (isCmdTranslate(userTextRaw)) {
    const { text: t } = parseCmdTranslate(userTextRaw);
    if (t && t.length >= 2) {
      const msgId = await saveMessage(
        sessionId, "user", userTextEN,
        { kind: "cmd_detected", cmd: "translate" },
        "en", userLang, origText, null
      );
      const out = await handleCmdTranslate(sessionId, userTextRaw, userLang);
      await logReply(sessionId, "cmd", "translate", null, msgId, "trigger: translate");
      return out;
    }
  }

  if (isCmdAnswerExpensive(userTextRaw)) {
    const msgId = await saveMessage(
      sessionId, "user", userTextEN,
      { kind: "cmd_detected", cmd: "answer_expensive" },
      "en", userLang, origText, null
    );
    const out = await handleCmdAnswerExpensive(sessionId, userLang);
    await logReply(sessionId, "cmd", "expensive", null, msgId, "trigger: answer expensive");
    return out;
  }

  // 2) Имя/контакт + факты
  // 2.1) извлечь имя/телефон из сообщения
  const nameInThisMsg = detectAnyName(userTextRaw);
  const phone = detectPhone(userTextRaw);
  if (nameInThisMsg || phone) await updateContact(sessionId, { name: nameInThisMsg, phone });

  // 2.2) дополнительно — имя из Telegram-метаданных
  await ensureName(sessionId, userTextRaw, extra?.tgMeta);

  // 2.3) быстрые факты из текста
  const facts = {};
  if (/чех/i.test(userTextRaw)) facts.country_interest = 'CZ';
  if (/польш/i.test(userTextRaw)) facts.country_interest = 'PL';
  if (/литв/i.test(userTextRaw))  facts.country_interest = 'LT';
  if (/работа/i.test(userTextRaw)) facts.intent_main = 'work';
  if (/бизнес/i.test(userTextRaw)) facts.intent_main = 'business';
  const num = userTextRaw.match(/\b(\d{1,3})\s*(кандидат|люд)/i)?.[1];
  if (num) facts.candidates_planned = Number(num);
  await upsertFacts(sessionId, facts);

  // 3) Сохраняем вход пользователя
  const userMsgId = await saveMessage(
    sessionId, "user", userTextEN,
    null, "en", userLang, origText, null
  );

  // 3.1) сохраняем вопрос в QnA-историю (для последующего «я бы ответил»)
  await saveUserQuestion(sessionId, userTextEN);

  // 4) Если имени ещё нет — спросим (один раз)
  const session = await getSession(sessionId);
  const knownName = nameInThisMsg || session?.user_name?.trim();
  if (!knownName) {
    const ask = buildAskName(userLang, userTextRaw);
    const { canonical } = await toEnglishCanonical(ask);
    await saveMessage(
      sessionId, "assistant", canonical,
      { category: "ask_name", strategy: "precheck_name" },
      "en", userLang, ask, "ask_name"
    );
    return ask;
  }

  // 5) Обновим стиль по последним сообщениям (лёгкая эвристика)
  await maybeUpdateStyle(sessionId);

  // 6) Классификация → маршрутизация по категориям
  const category = await classifyCategory(userTextRaw);

  switch (category) {
    case 'greeting':
    case 'smalltalk':
    case 'general':
    case 'visa':
    case 'work':
    case 'business':
    case 'docs':
    case 'price':
    case 'timeline':
    case 'process':
    case 'expensive':
    default:
      // общий путь (KB exact → KB category → LLM)
      return await routeByCategory({ category, sessionId, userLang, userTextEN, userMsgId });
  }
}
