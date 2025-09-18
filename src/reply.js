import { SYSTEM_PROMPT } from "./prompt.js";
import {
  upsertSession, updateContact, saveMessage, loadRecentMessages,
  loadLatestSummary, logReply, getLastAuditCategory, getSession,
  getPreviousUserUtterance
} from "./db.js";
import { kbFind, kbInsertTaughtAnswer, qnorm } from "./kb.js";
import {
  translateCached, translateWithStyle,
  toEnglishCanonical, detectLanguage, resolveTargetLangCode
} from "./translator.js";
import {
  classifyCategory, detectAnyName, detectPhone,
  isCmdTeach, parseCmdTeach,
  isCmdTranslate, parseCmdTranslate,
  isCmdAnswerExpensive, extractGreeting, stripQuoted
} from "./classifier.js";
import { runLLM } from "./llm.js";

/* Fallback к модели */
async function replyCore(sessionId, userTextEN) {
  const recent = await loadRecentMessages(sessionId, 24);
  const summary = await loadLatestSummary(sessionId);
  const messages = [{ role: "system", content: SYSTEM_PROMPT }];
  if (summary) messages.push({ role: "system", content: `Краткая сводка прошлой истории:\n${summary}` });
  messages.push(...recent.map(r => ({ role: r.role, content: r.content })));
  messages.push({ role: "user", content: userTextEN });
  const { text } = await runLLM(messages);
  return text;
}

/* Просьба имени */
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

/* ───────── Команды ───────── */
async function handleCmdTranslate(sessionId, rawText, userLang = "ru") {
  const { targetLangWord, text } = parseCmdTranslate(rawText);

  const targetLang = targetLangWord ? (resolveTargetLangCode(targetLangWord) || "en") : "en";

  if (!text || text.length < 2) {
    const msg = (userLang === "ru")
      ? "Нужен текст после команды «Переведи». Например: 'Переведи привет'."
      : "Text needed after 'Translate'. Example: 'Translate hello'.";
    const { canonical } = await toEnglishCanonical(msg);
    await saveMessage(sessionId,"assistant",canonical,
      { category: "translate", strategy: "cmd_translate_error" },
      "en", userLang, msg,"translate");
    return msg;
  }

  const { targetLang: tgt, styled, styledRu } = await translateWithStyle({ sourceText: text, targetLang });
  const combined = (userLang === "ru")
    ? `🔍 Перевод (${tgt.toUpperCase()}):\n${styled}\n\n💬 Для тебя (RU):\n${styledRu}`
    : `🔍 Translation (${tgt.toUpperCase()}):\n${styled}\n\n💬 For you (RU):\n${styledRu}`;

  const { canonical } = await toEnglishCanonical(combined);
  await saveMessage(sessionId,"assistant",canonical,
    { category: "translate", strategy: "cmd_translate" },
    "en", userLang, combined,"translate");
  return combined;
}

async function handleCmdTeach(sessionId, rawText, userLang = "ru") {
  const taught = parseCmdTeach(rawText);
  if (!taught) {
    const msg = (userLang === "ru")
      ? "Нужен текст после команды. Например: 'Я бы ответил: Спасибо!'"
      : "Text needed after the command. Example: 'I would answer: Thanks!'";
    const { canonical } = await toEnglishCanonical(msg);
    await saveMessage(sessionId,"assistant",canonical,
      { category: "teach", strategy: "cmd_teach_error" },
      "en", userLang, msg,"teach");
    return msg;
  }

  // берём прошлую реплику пользователя (до команды)
  const { text: prevUser } = await getPreviousUserUtterance(sessionId);
  const lastCat = (await getLastAuditCategory(sessionId)) || "general";
  const kbId = await kbInsertTaughtAnswer(lastCat, userLang, taught, prevUser || null, true);

  const out = (userLang === "ru")
    ? `✅ Ответ добавлен в базу знаний.\n\n«${taught}»`
    : `✅ Answer added to knowledge base.\n\n«${taught}»`;

  const { canonical } = await toEnglishCanonical(out);
  await saveMessage(sessionId,"assistant",canonical,
    { category: lastCat, strategy: "cmd_teach", kb_id: kbId },
    "en", userLang, out,lastCat);
  return out;
}

async function handleCmdAnswerExpensive(sessionId, userLang = "ru") {
  const kb = await kbFind("expensive", userLang, null);
  let answer;
  if (kb?.answer) {
    answer = userLang !== "ru" ? (await translateCached(kb.answer, "ru", userLang)).text : kb.answer;
  } else {
    answer = await replyCore(sessionId,
      "Client says it's expensive. WhatsApp-style response with value framing + CTA.");
  }
  const { canonical } = await toEnglishCanonical(answer);
  await saveMessage(sessionId,"assistant",canonical,
    { category: "expensive", strategy: "cmd_answer_expensive" },
    "en", userLang, answer,"expensive");
  await logReply(sessionId,"cmd","expensive",kb?.id||null,null,"trigger: answer expensive");
  return answer;
}

/* ───────── SmartReply ───────── */
export async function smartReply(sessionKey, channel, userTextRaw, userLangHint = "ru") {
  const sessionId = await upsertSession(sessionKey, channel);

  const { canonical: userTextEN, sourceLang: srcLang, original: origText } =
    await toEnglishCanonical(userTextRaw);
  const userLang = srcLang || userLangHint;
  const cleanUserText = stripQuoted(userTextRaw);

  /* Команды */
  if (isCmdTeach(cleanUserText)) {
    const msgId = await saveMessage(sessionId,"user",userTextEN,
      { kind:"cmd_detected", cmd:"teach" },
      "en",userLang,origText,null);
    const out = await handleCmdTeach(sessionId, userTextRaw, userLang);
    await logReply(sessionId,"cmd","teach",null,msgId,"trigger: teach");
    return out;
  }
  if (isCmdTranslate(cleanUserText)) {
    const msgId = await saveMessage(sessionId,"user",userTextEN,
      { kind:"cmd_detected", cmd:"translate" },
      "en",userLang,origText,null);
    const out = await handleCmdTranslate(sessionId, userTextRaw, userLang);
    await logReply(sessionId,"cmd","translate",null,msgId,"trigger: translate");
    return out;
  }
  if (isCmdAnswerExpensive(cleanUserText)) {
    const msgId = await saveMessage(sessionId,"user",userTextEN,
      { kind:"cmd_detected", cmd:"answer_expensive" },
      "en",userLang,origText,null);
    const out = await handleCmdAnswerExpensive(sessionId,userLang);
    await logReply(sessionId,"cmd","expensive",null,msgId,"trigger: answer expensive");
    return out;
  }

  /* Имя/телефон */
  const nameInThisMsg = detectAnyName(userTextRaw);
  const phone = detectPhone(userTextRaw);
  if (nameInThisMsg || phone) await updateContact(sessionId, { name: nameInThisMsg, phone });

  const userMsgId = await saveMessage(sessionId,"user",userTextEN,null,"en",userLang,origText,null);

  const session = await getSession(sessionId);
  const knownName = nameInThisMsg || session?.user_name?.trim();
  if (!knownName) {
    const ask = buildAskName(userLang, userTextRaw);
    const { canonical } = await toEnglishCanonical(ask);
    await saveMessage(sessionId,"assistant",canonical,
      { category: "ask_name", strategy: "precheck_name" },
      "en",userLang,ask,"ask_name");
    return ask;
  }

  /* Классификация */
  const category = await classifyCategory(userTextRaw);

  // пробуем KB ТОЛЬКО при хорошем совпадении вопроса (≥0.9)
  let kb = await kbFind(category, userLang, userTextRaw);
  let answer, strategy="fallback_llm", kbItemId=null;

  if (kb) {
    answer = kb.answer; strategy="kb_hit"; kbItemId=kb.id;
  } else {
    // KB не сработал — никаких случайных ответов из KB
    // дальше: интро/варианты/LLM
    const GENERAL_VARIANTS_RU = [
      "Подскажите, что сейчас приоритетнее — кандидаты или запуск бизнеса? Я предложу оптимальный шаг.",
      "Расскажите, с чего начнём: персонал или регистрация бизнеса в ЕС? Сориентирую по срокам.",
      "Давайте определим фокус: найм сотрудников или оформление бизнеса? Подскажу, как быстрее двигаться."
    ];
    const pick = arr => arr[Math.floor(Math.random()*arr.length)];
    const recent = await loadRecentMessages(sessionId,4);
    const turns = recent.filter(m => m.role==="user"||m.role==="assistant").length;

    if (category==="general" && turns<2) {
      answer = (userLang==="ru")
        ? "Чтобы быстро сориентировать вас: приоритет — кандидаты или запуск бизнеса в ЕС?"
        : "To guide you quickly: priority — candidates or starting a business in the EU?";
      strategy="intro_once";
    } else if (category==="general") {
      answer = (userLang==="ru") ? pick(GENERAL_VARIANTS_RU)
        : (await translateCached(pick(GENERAL_VARIANTS_RU),"ru",userLang)).text;
      strategy="general_variants";
    } else {
      answer = await replyCore(sessionId,userTextEN);
      const detectedLLM = await detectLanguage(answer);
      if (detectedLLM !== userLang)
        answer = (await translateCached(answer,detectedLLM,userLang)).text;
      strategy="fallback_llm";
    }
  }

  const { canonical: ansEN } = await toEnglishCanonical(answer);
  await logReply(sessionId,strategy,category,kbItemId,userMsgId,null);
  await saveMessage(sessionId,"assistant",ansEN,{ category:strategy },
    "en",userLang,answer,category);

  return answer;
}