// /src/reply.js
import { SYSTEM_PROMPT } from "./prompt.js";
import {
  upsertSession, updateContact, saveMessage, loadRecentMessages,
  loadLatestSummary, logReply, getLastAuditCategory, getSession,
  getLastAssistantMessage, insertCorrection, findCorrectionsByCategory
} from "./db.js";
import { kbFind } from "./kb.js";
import {
  translateCached, translateWithStyle,
  toEnglishCanonical, detectLanguage
} from "./translator.js";
import {
  classifyCategory, detectAnyName, detectPhone,
  isCmdTeach, parseCmdTeach, isCmdTranslate, parseCmdTranslate,
  isCmdAnswerExpensive, extractGreeting, stripQuoted,
  isSlashTeach, isSlashTranslate, isSlashExpensive
} from "./classifier.js";
import { runLLM } from "./llm.js";

/* ─────────── внутренние утилиты ─────────── */
function looksLikeShortAck(s="") {
  const t = (s || "").trim();
  if (t.length <= 2) return true; // ок, да, ok, yes
  if (t.length <= 30 && !t.includes("?")) return true;
  return false;
}
function similar(a="", b="") {
  const A = (a||"").trim().toLowerCase();
  const B = (b||"").trim().toLowerCase();
  if (!A || !B) return false;
  if (A === B) return true;
  const shorter = A.length < B.length ? A : B;
  const longer  = A.length < B.length ? B : A;
  return longer.includes(shorter) && shorter.length >= Math.min(60, longer.length * 0.8);
}

function buildAskName(userLang, rawText) {
  const hi = extractGreeting(rawText);
  const by = {
    ru: `${hi ? hi + ". " : ""}Подскажите, пожалуйста, как вас зовут, чтобы я знал, как к вам обращаться?`,
    uk: `${hi ? hi + ". " : ""}Підкажіть, будь ласка, як вас звати, щоб я знав, як до вас звертатись?`,
    pl: `${hi ? hi + ". " : ""}Proszę podpowiedzieć, jak ma Pan/Pani na imię, żebym wiedział, jak się zwracać?`,
    cz: `${hi ? hi + ". " : ""}Prosím, jak se jmenujete, ať vím, jak vás oslovovat?`,
    en: `${hi ? hi + ". " : ""}May I have your name so I know how to address you?`
  };
  return by[userLang] || by.en;
}

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
  const targetLang = (targetLangWord || "en").toLowerCase();

  if (!text || text.length < 2) {
    const msg = "Нужен текст после команды «Переведи» / /translate.";
    const { canonical } = await toEnglishCanonical(msg);
    await saveMessage(sessionId, "assistant", canonical, { category: "translate", strategy: "cmd" }, "en", userLang, msg, "translate");
    return [msg];
  }

  const { targetLang: tgt, styled, styledRu, altStyled, altStyledRu } =
    await translateWithStyle({ sourceText: text, targetLang });

  const outMessages = [styled, styledRu];
  if (altStyled) {
    outMessages.push(altStyled);
    if (altStyledRu) outMessages.push(altStyledRu);
  }

  const combinedForStore = outMessages.join("\n\n");
  const { canonical } = await toEnglishCanonical(combinedForStore);
  await saveMessage(
    sessionId,
    "assistant",
    canonical,
    { category: "translate", strategy: "cmd", target: tgt, pieces: outMessages.length },
    "en", userLang, combinedForStore, "translate"
  );

  return outMessages;
}

// /teach и «Ответил бы…»: ИСПРАВИТЬ последний ответ бота
async function handleCmdTeach(sessionId, rawText, userLang = "ru") {
  const taughtLocal = parseCmdTeach(rawText);
  if (!taughtLocal) {
    const msg = "Нужен текст после «Ответил бы…» / /teach.";
    const { canonical } = await toEnglishCanonical(msg);
    await saveMessage(sessionId, "assistant", canonical, { category: "teach", strategy: "cmd" }, "en", userLang, msg, "teach");
    return [msg];
  }

  // Берём последний НОРМАЛЬНЫЙ ответ ассистента
  const lastBot = await getLastAssistantMessage(sessionId);
  if (!lastBot) {
    const msg = "Нет моего предыдущего ответа в этой сессии. Напиши любой вопрос, и я отвечу — потом сможешь меня поправить.";
    const { canonical } = await toEnglishCanonical(msg);
    await saveMessage(sessionId, "assistant", canonical, { category: "teach", strategy: "cmd" }, "en", userLang, msg, "teach");
    return [msg];
  }

  const prev_en = lastBot.content || ""; // в messages.content мы храним EN-канон
  const prev_cat = lastBot.category || (await getLastAuditCategory(sessionId)) || "general";
  const { canonical: taught_en } = await toEnglishCanonical(taughtLocal);

  const corrId = await insertCorrection({
    session_id: sessionId,
    bot_message_id: lastBot.id,
    category: prev_cat,
    prev_answer_en: prev_en,
    taught_en,
    taught_local: taughtLocal,
    taught_lang: userLang
  });

  // В messages.content сохраняем только чек,
  // сам обучающий текст уходит в meta и таблицу corrections
  const human = `✅ В базу добавлено.`;
  const { canonical: storeEN } = await toEnglishCanonical(human);
  await saveMessage(
    sessionId,
    "assistant",
    storeEN,
    {
      category: prev_cat,
      strategy: "cmd_teach",
      corr_id: corrId,
      taught_text: taughtLocal,
      taught_en,
      prev_bot_msg_id: lastBot.id
    },
    "en",
    userLang,
    `✅ В базу добавлено.\n\n${taughtLocal}`,
    prev_cat
  );

  // Возвращаем чек + сам текст пользователю (двумя строками — удобно копировать)
  return [`✅ В базу добавлено.`, taughtLocal];
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
  await saveMessage(sessionId, "assistant", canonical, { category: "expensive", strategy: "cmd" }, "en", userLang, answer, "expensive");
  await logReply(sessionId, "cmd", "expensive", kb?.id || null, null, "trigger: answer expensive");
  return [answer];
}

/* ─────────── Применение правок к черновику ответа ─────────── */
async function applyCorrectionsIfAny({ category, draftAnswer, userLang }) {
  const { canonical: draftEN } = await toEnglishCanonical(draftAnswer);
  const rows = await findCorrectionsByCategory(category, 20);
  for (const c of rows) {
    if (similar(draftEN, c.prev_answer_en)) {
      // Нашли подходящую правку
      if (c.taught_lang && c.taught_local) {
        if (c.taught_lang === userLang) return c.taught_local;
        const { text } = await translateCached(c.taught_en, "en", userLang);
        return text;
      }
      // на всякий случай
      const { text } = await translateCached(c.taught_en, "en", userLang);
      return text;
    }
  }
  return draftAnswer;
}

/* ─────────── Основной роутер ─────────── */
export async function smartReply(sessionKey, channel, userTextRaw, userLangHint = "ru") {
  const sessionId = await upsertSession(sessionKey, channel);

  const { canonical: userTextEN, sourceLang: srcLang, original: origText } = await toEnglishCanonical(userTextRaw);
  const userLang = srcLang || userLangHint;
  const cleaned = stripQuoted(userTextRaw);

  // 0) Слэш-команды
  if (isSlashTeach(cleaned)) {
    const taught = cleaned.replace(/^\/teach\b\s*/i, "");
    return await handleCmdTeach(sessionId, `Ответил бы ${taught}`, userLang);
  }
  if (isSlashTranslate(cleaned)) {
    const payload = cleaned.replace(/^\/translate\b\s*/i, "переведи ");
    return await handleCmdTranslate(sessionId, payload, userLang);
  }
  if (isSlashExpensive(cleaned)) {
    return await handleCmdAnswerExpensive(sessionId, userLang);
  }

  // 1) Естественные команды
  if (isCmdTeach(cleaned)) {
    const msgId = await saveMessage(sessionId, "user", userTextEN, { kind: "cmd_detected", cmd: "teach" }, "en", userLang, origText, null);
    const out = await handleCmdTeach(sessionId, cleaned, userLang);
    await logReply(sessionId, "cmd", "teach", null, msgId, "trigger: teach(last_bot)");
    return out;
  }
  if (isCmdTranslate(cleaned)) {
    const { text: t } = parseCmdTranslate(cleaned);
    if (t && t.length >= 2) {
      const msgId = await saveMessage(sessionId, "user", userTextEN, { kind: "cmd_detected", cmd: "translate" }, "en", userLang, origText, null);
      const out = await handleCmdTranslate(sessionId, cleaned, userLang);
      await logReply(sessionId, "cmd", "translate", null, msgId, "trigger: translate");
      return out;
    }
  }
  if (isCmdAnswerExpensive(cleaned)) {
    const msgId = await saveMessage(sessionId, "user", userTextEN, { kind: "cmd_detected", cmd: "answer_expensive" }, "en", userLang, origText, null);
    const out = await handleCmdAnswerExpensive(sessionId, userLang);
    await logReply(sessionId, "cmd", "expensive", null, msgId, "trigger: answer expensive");
    return out;
  }

  // 2) Имя/телефон
  const nameInThisMsg = detectAnyName(userTextRaw);
  const phone = detectPhone(userTextRaw);
  if (nameInThisMsg || phone) await updateContact(sessionId, { name: nameInThisMsg, phone });

  // 3) Сохраняем вход
  const userMsgId = await saveMessage(sessionId, "user", userTextEN, null, "en", userLang, origText, null);

  // 4) Если имя неизвестно — спросим один раз
  const session = await getSession(sessionId);
  const knownName = nameInThisMsg || session?.user_name?.trim();
  if (!knownName) {
    const ask = buildAskName(userLang, userTextRaw);
    const { canonical } = await toEnglishCanonical(ask);
    await saveMessage(sessionId, "assistant", canonical, { category: "ask_name", strategy: "cmd" }, "en", userLang, ask, "ask_name");
    return [ask];
  }

  // 5) KB → перевод → LLM (черновик)
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

  // 6) Применяем правки для этой категории (если черновик похож на прежние ответы бота)
  answer = await applyCorrectionsIfAny({ category, draftAnswer: answer, userLang });

  // 7) Сохраняем исход
  const { canonical: ansEN } = await toEnglishCanonical(answer);
  await logReply(sessionId, strategy, category, kbItemId, userMsgId, null);
  await saveMessage(sessionId, "assistant", ansEN, { category, strategy }, "en", userLang, answer, category);

  return [answer];
}