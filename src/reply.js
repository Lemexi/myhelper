// /src/reply.js
import { SYSTEM_PROMPT } from "./prompt.js";
import {
  upsertSession, updateContact, saveMessage, loadRecentMessages,
  loadLatestSummary, logReply, getLastAuditCategory, getSession
} from "./db.js";
import { kbFind, kbInsertAnswer } from "./kb.js";
import {
  translateCached, translateWithStyle, resolveTargetLangCode,
  toEnglishCanonical, detectLanguage
} from "./translator.js";
import {
  classifyCategory, detectName, detectPhone,
  isCmdTeach, parseCmdTeach,
  isCmdTranslate, parseCmdTranslate,
  isCmdAnswerExpensive, honorific, guessGenderByName
} from "./classifier.js";
import { runLLM } from "./llm.js";

/* ─────────────────────────────────────────
   LLM фолбэк с контекстом и сводкой
────────────────────────────────────────── */
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

/* ─────────────────────────────────────────
   Команды: Переведи / Ответил бы / Ответь на дорого
────────────────────────────────────────── */
async function handleCmdTranslate(sessionId, rawText, userLang = "ru") {
  const { targetLangWord, text } = parseCmdTranslate(rawText);
  const targetLang = resolveTargetLangCode(targetLangWord) || "en";
  if (!text) {
    const msg = "Нужен текст после команды «Переведи».";
    await saveMessage(sessionId, "assistant", msg, { category: "translate", strategy: "cmd_translate_error" }, "en", userLang, rawText, "translate");
    return msg;
  }
  const { styled, styledRu, targetLang: tgt } = await translateWithStyle({ sourceText: text, targetLang });
  const combined = `🔁 Перевод (${tgt.toUpperCase()}):\n${styled}\n\n💬 Для тебя (RU):\n${styledRu}`;
  // Канонически в EN
  const { canonical } = await toEnglishCanonical(combined);
  await saveMessage(sessionId, "assistant", canonical, { category: "translate", strategy: "cmd_translate" }, "en", userLang, rawText, "translate");
  return combined;
}

async function handleCmdTeach(sessionId, rawText, userLang = "ru") {
  const taught = parseCmdTeach(rawText);
  if (!taught) {
    const msg = "Нужен текст после «Ответил бы:».";
    await saveMessage(sessionId, "assistant", msg, { category: "teach", strategy: "cmd_teach_error" }, "en", userLang, rawText, "teach");
    return msg;
  }
  const lastCat = (await getLastAuditCategory(sessionId)) || "general";
  const kbId = await kbInsertAnswer(lastCat, userLang || "ru", taught, true);
  const ack = "✅ В базу добавлено.";
  const out = `${ack}\n\n${taught}`;
  const { canonical } = await toEnglishCanonical(out);
  await saveMessage(sessionId, "assistant", canonical, { category: lastCat, strategy: "cmd_teach", kb_id: kbId }, "en", userLang, rawText, lastCat);
  return out;
}

async function handleCmdAnswerExpensive(sessionId, userLang = "ru") {
  const kb = (await kbFind("expensive", userLang)) || (await kbFind("expensive", "ru"));
  let answer;
  if (kb?.answer) {
    if (userLang !== "ru") {
      const { text: translated } = await translateCached(kb.answer, "ru", userLang);
      answer = translated;
    } else {
      answer = kb.answer;
    }
  } else {
    answer = await replyCore(sessionId, "Client says it's expensive. Give a brief WhatsApp-style response with value framing and a clear CTA.");
  }
  const { canonical } = await toEnglishCanonical(answer);
  await saveMessage(sessionId, "assistant", canonical, { category: "expensive", strategy: "cmd_answer_expensive" }, "en", userLang, answer, "expensive");
  await logReply(sessionId, "cmd", "expensive", kb?.id || null, null, "trigger: answer expensive");
  return answer;
}

/* ─────────────────────────────────────────
   Имя и обращение
────────────────────────────────────────── */
function addAddressing(answerText, userLang, session) {
  const name = session?.user_name?.trim();
  if (name) return answerText; // имя есть — не навязываем обращение
  const gender = "male"; // по умолчанию
  const hon = honorific(userLang || "ru", gender);
  return `${hon}, ${answerText}`;
}

/* ─────────────────────────────────────────
   Основной SmartReply
────────────────────────────────────────── */
export async function smartReply(sessionKey, channel, userTextRaw, userLangHint = "ru") {
  const sessionId = await upsertSession(sessionKey, channel);

  // Канонизируем вход: всё в EN, оригинал сохраняем в полях translated_*
  const { canonical: userTextEN, sourceLang: srcLang, original: origText } = await toEnglishCanonical(userTextRaw);
  const userLang = srcLang || userLangHint;

  // Обновим контакты (если прислали)
  const nameDetected = detectName(userTextRaw);
  const phone = detectPhone(userTextRaw);
  if (nameDetected || phone) await updateContact(sessionId, { name: nameDetected, phone });

  // Сохраняем входящее как EN
  const userMsgId = await saveMessage(
    sessionId,
    "user",
    userTextEN,
    null,
    "en",            // lang (канонически EN)
    userLang,        // translated_to (исходный язык пользователя)
    origText,        // translated_content (оригинал)
    null
  );

  // Сессия (для имени)
  const session = await getSession(sessionId);
  const currentName = session?.user_name?.trim();

  // Если имени нет и это не команда — сначала спросим имя
  if (!currentName && !isCmdTranslate(userTextRaw) && !isCmdTeach(userTextRaw) && !isCmdAnswerExpensive(userTextRaw)) {
    const askNameByLang = {
      ru: "Как вас зовут? Имя нужно для договора и общения.",
      uk: "Як вас звати? Ім’я потрібне для договору і спілкування.",
      pl: "Jak masz na imię? Imię potrzebne do umowy i kontaktu.",
      cz: "Jak se jmenujete? Jméno je potřeba do smlouvy a komunikace.",
      en: "How should I address you? Your name is needed for the agreement and communication."
    };
    const ask = askNameByLang[userLang] || askNameByLang["en"];
    const { canonical } = await toEnglishCanonical(ask);
    await saveMessage(sessionId, "assistant", canonical, { category: "ask_name", strategy: "precheck_name" }, "en", userLang, ask, "ask_name");
    return ask;
  }

  // Команды (высший приоритет)
  if (isCmdTranslate(userTextRaw)) {
    const out = await handleCmdTranslate(sessionId, userTextRaw, userLang);
    await logReply(sessionId, "cmd", "translate", null, userMsgId, "trigger: translate");
    return out;
  }
  if (isCmdTeach(userTextRaw)) {
    const out = await handleCmdTeach(sessionId, userTextRaw, userLang);
    await logReply(sessionId, "cmd", "teach", null, userMsgId, "trigger: teach");
    return out;
  }
  if (isCmdAnswerExpensive(userTextRaw)) {
    const out = await handleCmdAnswerExpensive(sessionId, userLang);
    await logReply(sessionId, "cmd", "expensive", null, userMsgId, "trigger: answer expensive");
    return out;
  }

  // Классификация
  const category = await classifyCategory(userTextRaw);

  // KB → перевод → LLM
  let kb = await kbFind(category, userLang);
  let answer, strategy = "fallback_llm", kbItemId = null;

  if (kb) {
    answer = kb.answer;
    strategy = "kb_hit";
    kbItemId = kb.id;
  } else {
    const kbRu = await kbFind(category, "ru");
    if (kbRu) {
      const { text: translated } = await translateCached(kbRu.answer, "ru", userLang);
      answer = translated;
      strategy = "kb_translated";
      kbItemId = kbRu.id;
    }
  }
  if (!answer) {
    // В LLM отправляем EN-контекст
    answer = await replyCore(sessionId, userTextEN);
    // И переводим результат на язык пользователя
    const detectedLLM = await detectLanguage(answer);
    if (detectedLLM !== userLang) {
      const { text: translatedOut } = await translateCached(answer, detectedLLM, userLang);
      answer = translatedOut;
    }
  }

  // Вставим обращение (если имени нет)
  const finalAnswer = addAddressing(answer, userLang, session);

  // Сохраняем исходящее как EN (канон), а пользовательский язык — в translated_*
  const { canonical: ansEN } = await toEnglishCanonical(finalAnswer);
  await logReply(sessionId, strategy, category, kbItemId, userMsgId, null);
  await saveMessage(
    sessionId,
    "assistant",
    ansEN,
    { category, strategy },
    "en",
    userLang,
    finalAnswer,
    category
  );

  return finalAnswer;
}
