// /src/reply.js
import { SYSTEM_PROMPT } from "./prompt.js";
import {
  upsertSession, updateContact, saveMessage, loadRecentMessages,
  loadLatestSummary, logReply, getLastAuditCategory, getSession,
  qnaFind, qnaTouchUse, getLastAssistantMessage, qnaInsert
} from "./db.js";
import { kbFind, kbInsertAnswer } from "./kb.js";
import {
  translateCached, translateWithStyle, toEnglishCanonical, detectLanguage, resolveTargetLangCode
} from "./translator.js";
import {
  classifyCategory, detectAnyName, detectPhone,
  isCmdTeach, parseCmdTeach,
  isCmdTranslate, parseCmdTranslate,
  isCmdAnswerExpensive, extractGreeting, norm
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

/* Просьба имени */
function buildAskName(userLang, rawText) {
  const hi = extractGreeting(rawText);
  const by = {
    ru: `${hi ? hi + ". " : ""}Подскажите, пожалуйста, как вас зовут, чтобы я знал, как к вам обращаться?`,
    uk: `${hi ? hi + ". " : ""}Підкажіть, будь ласка, як вас звати, щоб я знав, як до вас звертатись?`,
    pl: `${hi ? hi + ". " : ""}Proszę podpowiedzieć, jak ma Pan/Pani na imię, żebym wiedział, как się zwracać?`,
    cz: `${hi ? hi + ". " : ""}Prosím, jak se jmenujete, ať vím, jak vás oslovovat?`,
    en: `${hi ? hi + ". " : ""}May I have your name so I know how to address you?`
  };
  return by[userLang] || by.en;
}

/* ── Перевод: чистый вывод + запись в QnA ── */
async function handleCmdTranslate(sessionId, rawText, userLang = "ru") {
  const { targetLangWord, text } = parseCmdTranslate(rawText);
  // если язык явно не указан — по умолчанию EN (твоё требование)
  const guess = resolveTargetLangCode(targetLangWord || "") || "en";
  const targetLang = (guess || "en").toLowerCase();

  if (!text || text.length < 2) {
    const msg = "Нужен текст после команды «Переведи».";
    const { canonical } = await toEnglishCanonical(msg);
    await saveMessage(sessionId, "assistant", canonical, { category: "translate", strategy: "cmd_translate_error" }, "en", userLang, msg, "translate");
    return msg;
  }

  // Усиленный B2B-стиль
  const { targetLang: tgt, styled } = await translateWithStyle({ sourceText: text, targetLang });

  // Сохраняем в QnA по исходной фразе (канон EN ключа)
  const { canonical: qCanonEN } = await toEnglishCanonical(text);
  const qNormEN = norm((qCanonEN || "").toLowerCase());
  await qnaInsert({
    lang: tgt,
    questionNormEn: qNormEN,
    questionRaw: text,
    answerText: styled,
    source: "translate",
    sessionId
  });

  // Сохраняем ответ в лог (канон EN)
  const { canonical } = await toEnglishCanonical(styled);
  await saveMessage(sessionId, "assistant", canonical, { category: "translate", strategy: "cmd_translate" }, "en", userLang, styled, "translate");

  // Пользователю — сразу готовый текст без лейблов
  return styled;
}

/* ── Обучение «Я бы ответил…»: привязка к последнему ассистентскому ── */
async function handleCmdTeach(sessionId, rawText, userLang = "ru") {
  const taught = parseCmdTeach(rawText);
  if (!taught) {
    const msg = "Нужен текст после «Ответил бы».";
    const { canonical } = await toEnglishCanonical(msg);
    await saveMessage(sessionId, "assistant", canonical, { category: "teach", strategy: "cmd_teach_error" }, "en", userLang, msg, "teach");
    return msg;
  }

  // Привязка к ПОСЛЕДНЕМУ сообщению ассистента
  const lastA = await getLastAssistantMessage(sessionId);
  const baseQuestion = lastA?.translated_content || lastA?.content || "";
  const { canonical: qCanonEN } = await toEnglishCanonical(baseQuestion || "");
  const qNormEN = norm((qCanonEN || "").toLowerCase());

  // Вставка в QnA
  const qnaId = await qnaInsert({
    lang: userLang,
    questionNormEn: qNormEN,
    questionRaw: baseQuestion,
    answerText: taught,
    source: "teach",
    sessionId
  });

  // (опционально) дублируем по последней категории
  const lastCat = (await getLastAuditCategory(sessionId)) || "general";
  const kbId = await kbInsertAnswer(lastCat, userLang || "ru", taught, true);

  // Чёткий статус
  const out = `✅ В базу внесено.\n\n${taught}`;
  const { canonical } = await toEnglishCanonical(out);
  await saveMessage(sessionId, "assistant", canonical, { category: lastCat, strategy: "cmd_teach", kb_id: kbId, qna_id: qnaId }, "en", userLang, out, lastCat);
  return out;
}

/* ── Возражение «дорого» ── */
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

/* ── SmartReply ── */
export async function smartReply(sessionKey, channel, userTextRaw, userLangHint = "ru") {
  const sessionId = await upsertSession(sessionKey, channel);

  // Канон EN + определяем язык пользователя
  const { canonical: userTextEN, sourceLang: srcLang, original: origText } = await toEnglishCanonical(userTextRaw);
  const userLang = srcLang || userLangHint;

  // 0) Команды — строго ДО всего (сырое сообщение)
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
  }

  if (isCmdAnswerExpensive(userTextRaw)) {
    const msgId = await saveMessage(sessionId, "user", userTextEN, { kind: "cmd_detected", cmd: "answer_expensive" }, "en", userLang, origText, null);
    const out = await handleCmdAnswerExpensive(sessionId, userLang);
    await logReply(sessionId, "cmd", "expensive", null, msgId, "trigger: answer expensive");
    return out;
  }

  // 1) Имя/телефон
  const nameInThisMsg = detectAnyName(userTextRaw);
  const phone = detectPhone(userTextRaw);
  if (nameInThisMsg || phone) await updateContact(sessionId, { name: nameInThisMsg, phone });

  // 2) Сохраняем вход
  const userMsgId = await saveMessage(sessionId, "user", userTextEN, null, "en", userLang, origText, null);

  // 3) Если имени нет — просим имя
  const session = await getSession(sessionId);
  const knownName = nameInThisMsg || session?.user_name?.trim();
  if (!knownName) {
    const ask = buildAskName(userLang, userTextRaw);
    const { canonical } = await toEnglishCanonical(ask);
    await saveMessage(sessionId, "assistant", canonical, { category: "ask_name", strategy: "precheck_name" }, "en", userLang, ask, "ask_name");
    return ask;
  }

  // 4) QnA поверх всего
  const qNormEN = norm((userTextEN || "").toLowerCase());
  const qnaHit = await qnaFind(userLang, qNormEN);
  if (qnaHit) {
    const answer = qnaHit.answer_text;
    const { canonical: ansEN } = await toEnglishCanonical(answer);
    await saveMessage(sessionId, "assistant", ansEN, { category: "qna", strategy: "kb_qna" }, "en", userLang, answer, "qna");
    await qnaTouchUse(qnaHit.id);
    await logReply(sessionId, "kb_qna", "qna", null, userMsgId, "hit by norm EN");
    return answer;
  }

  // 5) KB → LLM
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
