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
  isCmdAnswerExpensive, extractGreeting, stripQuoted
} from "./classifier.js";
import { runLLM } from "./llm.js";

/* LLM fallback */
async function replyCore(sessionId, userTextEN) {
  const recent = await loadRecentMessages(sessionId, 24);
  const summary = await loadLatestSummary(sessionId);
  const messages = [{ role: "system", content: SYSTEM_PROMPT }];
  if (summary) messages.push({ role: "system", content: `Краткая сводка прошлой истории:\n${summary}` });
  messages.push(...recent);
  messages.push({ role: "user", content: userTextEN });
  const { text } = await runLLM(messages);
  return text;
}

/* Команды */
async function handleCmdTranslate(sessionId, rawText, userLang = "ru") {
  const { targetLangWord, text } = parseCmdTranslate(rawText);
  const targetLang = (targetLangWord || "en").toLowerCase();

  if (!text || text.length < 2) {
    const msg = "Нужен текст после команды «Переведи».";
    const { canonical } = await toEnglishCanonical(msg);
    await saveMessage(sessionId, "assistant", canonical, { category: "translate", strategy: "cmd_translate_error" }, "en", userLang, msg, "translate");
    return msg;
  }

  const { targetLang: tgt, styled, styledRu } = await translateWithStyle({ sourceText: text, targetLang });

  // Отдаём ДВА блока, всегда:
  // 1) Целевая версия для клиента; 2) Для тебя (RU)
  const combined =
    `🔍 Перевод (${tgt.toUpperCase()}):\n` +
    `${styled}\n\n` +
    `💬 Для тебя (RU):\n` +
    `${styledRu}`;

  // Сохраняем канонически в EN (в БД), оригинал комбинированного — в translated_content
  const { canonical } = await toEnglishCanonical(combined);
  await saveMessage(sessionId, "assistant", canonical, { category: "translate", strategy: "cmd_translate" }, "en", userLang, combined, "translate");

  return combined;
}

async function handleCmdTeach(sessionId, rawText, userLang = "ru") {
  const taught = parseCmdTeach(rawText);
  if (!taught) {
    const msg = "Нужен текст после «Ответил бы».";
    const { canonical } = await toEnglishCanonical(msg);
    await saveMessage(sessionId, "assistant", canonical, { category: "teach", strategy: "cmd_teach_error" }, "en", userLang, msg, "teach");
    return msg;
  }
  const lastCat = (await getLastAuditCategory(sessionId)) || "general";
  const kbId = await kbInsertAnswer(lastCat, userLang || "ru", taught, true);
  const out = `✅ В базу добавлено.\n\n${taught}`;
  const { canonical } = await toEnglishCanonical(out);
  await saveMessage(sessionId, "assistant", canonical, { category: lastCat, strategy: "cmd_teach", kb_id: kbId }, "en", userLang, out, lastCat);
  return out;
}

async function handleCmdAnswerExpensive(sessionId, userLang = "ru") {
  const kb = (await kbFind("expensive", userLang)) || (await kbFind("expensive", "ru"));
  let answer;
  if (kb?.answer) {
    answer = userLang !== "ru" ? (await translateCached(kb.answer, "ru", userLang)).text : kb.answer;
  } else {
    answer = await replyCore(sessionId, "Client says it's expensive. Give a brief WhatsApp-style response with value framing and a clear CTA.");
  }
  const { canonical } = await toEnglishCanonical(answer);
  await saveMessage(sessionId, "assistant", canonical, { category: "expensive", strategy: "cmd_answer_expensive" }, "en", userLang, answer, "expensive");
  await logReply(sessionId, "cmd", "expensive", kb?.id || null, null, "trigger: answer expensive");
  return answer;
}

/* SmartReply */
export async function smartReply(sessionKey, channel, userTextRaw, userLangHint = "ru") {
  const sessionId = await upsertSession(sessionKey, channel);

  // Канон EN + исходный язык
  const { canonical: userTextEN, sourceLang: srcLang, original: origText } = await toEnglishCanonical(userTextRaw);
  const userLang = srcLang || userLangHint;

  // 0) Команды — строго ДО всего. Передаем userTextRaw напрямую
  // функции isCmdTeach/isCmdTranslate сами делают stripQuoted + lower

  if (isCmdTeach(userTextRaw)) {
    const msgId = await saveMessage(sessionId, "user", userTextEN, { kind: "cmd_detected", cmd: "teach" }, "en", userLang, origText, null);
    const out = await handleCmdTeach(sessionId, userTextRaw, userLang);
    await logReply(sessionId, "cmd", "teach", null, msgId, "trigger: teach");
    return out;
  }

  if (isCmdTranslate(userTextRaw)) {
    const { text: t } = parseCmdTranslate(userTextRaw);
    if (t && t.length >= 2) {
      const msgId = await saveMessage(sessionId, "user", userTextEN, { kind: "cmd_detected", cmd: "translate" }, "en", userLang, origText, null);
      const out = await handleCmdTranslate(sessionId, userTextRaw, userLang);
      await logReply(sessionId, "cmd", "translate", null, msgId, "trigger: translate");
      return out;
    }
    // если пусто — игнор и идём дальше
  }

  if (isCmdAnswerExpensive(userTextRaw)) {
    const msgId = await saveMessage(sessionId, "user", userTextEN, { kind: "cmd_detected", cmd: "answer_expensive" }, "en", userLang, origText, null);
    const out = await handleCmdAnswerExpensive(sessionId, userLang);
    await logReply(sessionId, "cmd", "expensive", null, msgId, "trigger: answer expensive");
    return out;
  }

  // 1) Имя/телефон из текущего сообщения
  const nameInThisMsg = detectAnyName(userTextRaw);
  const phone = detectPhone(userTextRaw);
  if (nameInThisMsg || phone) await updateContact(sessionId, { name: nameInThisMsg, phone });

  // 2) Сохраняем вход
  const userMsgId = await saveMessage(sessionId, "user", userTextEN, null, "en", userLang, origText, null);

  // 3) Если имени нет — зеркалим приветствие и просим имя
  const session = await getSession(sessionId);
  const knownName = nameInThisMsg || session?.user_name?.trim();
  if (!knownName) {
    const ask = buildAskName(userLang, userTextRaw);
    const { canonical } = await toEnglishCanonical(ask);
    await saveMessage(sessionId, "assistant", canonical, { category: "ask_name", strategy: "precheck_name" }, "en", userLang, ask, "ask_name");
    return ask;
  }

  // 4) Классификация → KB → перевод → LLM
  const category = await classifyCategory(userTextRaw);

  let kb = await kbFind(category, userLang);
  let answer, strategy = "fallback_llm", kbItemId = null;

  if (kb) {
    answer = kb.answer; strategy = "kb_hit"; kbItemId = kb.id;
  } else {
    const kbRu = await kbFind(category, "ru");
    if (kbRu) {
      answer = (await translateCached(kbRu.answer, "ru", userLang)).text;
      strategy = "kb_translated"; kbItemId = kbRu.id;
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
  await saveMessage(sessionId, "assistant", ansEN, { category, strategy }, "en", userLang, answer, category);

  return answer;
}
