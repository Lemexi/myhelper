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
  classifyCategory, detectName, detectStandaloneName, detectPhone,
  isCmdTeach, parseCmdTeach,
  isCmdTranslate, parseCmdTranslate,
  isCmdAnswerExpensive, honorific, guessGenderByName, extractGreeting
} from "./classifier.js";
import { runLLM } from "./llm.js";

/* ─────────── LLM фолбэк ─────────── */
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

/* ─────────── Команды ─────────── */
async function handleCmdTranslate(sessionId, rawText, userLang = "ru") {
  const { targetLangWord, text } = parseCmdTranslate(rawText);
  const targetLang = targetLangWord ? targetLangWord : "en";
  if (!text) {
    const msg = "Нужен текст после команды «Переведи».";
    const { canonical } = await toEnglishCanonical(msg);
    await saveMessage(sessionId, "assistant", canonical, { category: "translate", strategy: "cmd_translate_error" }, "en", userLang, msg, "translate");
    return msg;
  }
  const { styled, styledRu, targetLang: tgt } = await translateWithStyle({ sourceText: text, targetLang });
  const combined = `🔁 Перевод (${tgt.toUpperCase()}):\n${styled}\n\n💬 Для тебя (RU):\n${styledRu}`;
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

/* ─────────── Умное приветствие + просьба имени ─────────── */
function buildAskName(userLang, rawText) {
  const hi = extractGreeting(rawText); // зеркалим если есть
  const askByLang = {
    ru: `${hi ? hi + ". " : ""}Подскажите, пожалуйста, как вас зовут, чтобы я знал, как к вам обращаться?`,
    uk: `${hi ? hi + ". " : ""}Підкажіть, будь ласка, як вас звати, щоб я знав, як до вас звертатись?`,
    pl: `${hi ? hi + ". " : ""}Proszę podpowiedzieć, jak ma Pan/Pani na imię, żebym wiedział, jak się zwracać?`,
    cz: `${hi ? hi + ". " : ""}Prosím, jak se jmenujete, ať vím, jak vás oslovovat?`,
    en: `${hi ? hi + ". " : ""}May I have your name so I know how to address you?`
  };
  return askByLang[userLang] || askByLang["en"];
}

/* ─────────── SmartReply ─────────── */
export async function smartReply(sessionKey, channel, userTextRaw, userLangHint = "ru") {
  const sessionId = await upsertSession(sessionKey, channel);

  // Канонизируем вход: всё в EN, оригинал сохраняем
  const { canonical: userTextEN, sourceLang: srcLang, original: origText } = await toEnglishCanonical(userTextRaw);
  const userLang = srcLang || userLangHint;

  // Детект контактов
  let nameDetected = detectName(userTextRaw) || detectStandaloneName(userTextRaw);
  const phone = detectPhone(userTextRaw);
  if (nameDetected || phone) await updateContact(sessionId, { name: nameDetected, phone });

  // Сохраняем входящее (канон EN)
  const userMsgId = await saveMessage(
    sessionId, "user", userTextEN,
    null, "en", userLang, origText, null
  );

  // Команды — перехватываем до всего
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

  // Проверим, знаем ли имя в сессии (после возможного апдейта)
  const session = await getSession(sessionId);
  const currentName = session?.user_name?.trim();

  // Если имени НЕТ → зеркалим приветствие и культурно просим имя (один раз)
  if (!currentName) {
    const ask = buildAskName(userLang, userTextRaw);
    const { canonical } = await toEnglishCanonical(ask);
    await saveMessage(sessionId, "assistant", canonical, { category: "ask_name", strategy: "precheck_name" }, "en", userLang, ask, "ask_name");
    return ask;
  }

  // Дальше обычная цепочка: классификация → KB → перевод → LLM
  const category = await classifyCategory(userTextRaw);

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
    // Фолбэк через LLM (в EN) + при необходимости перевод ответа на язык пользователя
    answer = await replyCore(sessionId, userTextEN);
    const detectedLLM = await detectLanguage(answer);
    if (detectedLLM !== userLang) {
      const { text: translatedOut } = await translateCached(answer, detectedLLM, userLang);
      answer = translatedOut;
    }
  }

  // Обращение (Сэр/Мэм) только если имени нет — но имя уже есть, поэтому не добавляем
  const finalAnswer = answer;

  // Сохраняем исходящее канонически EN
  const { canonical: ansEN } = await toEnglishCanonical(finalAnswer);
  await logReply(sessionId, strategy, category, kbItemId, userMsgId, null);
  await saveMessage(sessionId, "assistant", ansEN, { category, strategy }, "en", userLang, finalAnswer, category);

  return finalAnswer;
}
