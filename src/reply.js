// /src/reply.js
import { SYSTEM_PROMPT } from "./prompt.js";
import {
  upsertSession, updateContact, saveMessage, loadRecentMessages,
  loadLatestSummary, logReply, getLastAuditCategory, getSession,
  getLastTeachInfo
} from "./db.js";
import { kbFind, kbInsertAnswer } from "./kb.js";
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

/* ────────────────────────────────────────────────────────────────────────────
   LLM fallback
──────────────────────────────────────────────────────────────────────────── */
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

/* ────────────────────────────────────────────────────────────────────────────
   Просьба имени
──────────────────────────────────────────────────────────────────────────── */
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

/* ────────────────────────────────────────────────────────────────────────────
   Хелперы
──────────────────────────────────────────────────────────────────────────── */
function looksLikeShortAck(s="") {
  const t = (s || "").trim();
  if (t.length <= 2) return true; // ок, да, yes, ok
  if (t.length <= 30 && !t.includes("?")) return true;
  return false;
}
function similar(a="", b="") {
  const A = (a||"").trim().toLowerCase();
  const B = (b||"").trim().toLowerCase();
  if (!A || !B) return false;
  if (A === B) return true;
  // грубая схожесть: одно входит в другое и длина близкая
  const shorter = A.length < B.length ? A : B;
  const longer  = A.length < B.length ? B : A;
  return longer.includes(shorter) && shorter.length >= Math.min(60, longer.length * 0.8);
}

/* ────────────────────────────────────────────────────────────────────────────
   Команды
──────────────────────────────────────────────────────────────────────────── */
async function handleCmdTranslate(sessionId, rawText, userLang = "ru") {
  const { targetLangWord, text } = parseCmdTranslate(rawText);
  const targetLang = (targetLangWord || "en").toLowerCase();

  if (!text || text.length < 2) {
    const msg = "Нужен текст после команды «Переведи» / /translate.";
    const { canonical } = await toEnglishCanonical(msg);
    await saveMessage(sessionId, "assistant", canonical, { category: "translate", strategy: "cmd_translate_error" }, "en", userLang, msg, "translate");
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
    { category: "translate", strategy: "cmd_translate", target: tgt, pieces: outMessages.length },
    "en", userLang, combinedForStore, "translate"
  );

  return outMessages;
}

async function handleCmdTeach(sessionId, rawText, userLang = "ru") {
  const taught = parseCmdTeach(rawText);
  if (!taught) {
    const msg = "Нужен текст после «Ответил бы…» / /teach.";
    const { canonical } = await toEnglishCanonical(msg);
    await saveMessage(sessionId, "assistant", canonical, { category: "teach", strategy: "cmd_teach_error" }, "en", userLang, msg, "teach");
    return [msg];
  }
  const lastCat = (await getLastAuditCategory(sessionId)) || "general";
  console.log("[TEACH] cat:", lastCat, "| len:", taught.length);

  const kbId = await kbInsertAnswer(lastCat, userLang || "ru", taught, true);

  // В ОТВЕТ пользователю показываем чек+текст,
  // НО в messages.content сохраняем ТОЛЬКО чек (чтобы не эхоить в диалоге).
  const outHuman = `✅ В базу добавлено.\n\n${taught}`;
  const outStore = `✅ В базу добавлено.`;

  const { canonical: storeEN } = await toEnglishCanonical(outStore);
  await saveMessage(
    sessionId,
    "assistant",
    storeEN,
    { category: lastCat, strategy: "cmd_teach", kb_id: kbId, taught_text: taught, taught_len: taught.length },
    "en", userLang, outHuman, lastCat
  );
  return [outHuman];
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
  return [answer];
}

/* ────────────────────────────────────────────────────────────────────────────
   SmartReply
──────────────────────────────────────────────────────────────────────────── */
export async function smartReply(sessionKey, channel, userTextRaw, userLangHint = "ru") {
  const sessionId = await upsertSession(sessionKey, channel);

  const { canonical: userTextEN, sourceLang: srcLang, original: origText } = await toEnglishCanonical(userTextRaw);
  const userLang = srcLang || userLangHint;

  const cleaned = stripQuoted(userTextRaw);

  // ── 0) СЛЭШ-КОМАНДЫ — абсолютный приоритет
  if (isSlashTeach(cleaned)) {
    const taught = cleaned.replace(/^\/teach\b\s*/i, "");
    const out = await handleCmdTeach(sessionId, `Ответил бы ${taught}`, userLang);
    return out;
  }
  if (isSlashTranslate(cleaned)) {
    const payload = cleaned.replace(/^\/translate\b\s*/i, "переведи ");
    const out = await handleCmdTranslate(sessionId, payload, userLang);
    return out;
  }
  if (isSlashExpensive(cleaned)) {
    const out = await handleCmdAnswerExpensive(sessionId, userLang);
    return out;
  }

  // ── 1) ЕСТЕСТВЕННЫЕ КОМАНДЫ (teach → translate → expensive)
  if (isCmdTeach(cleaned)) {
    const msgId = await saveMessage(sessionId, "user", userTextEN, { kind: "cmd_detected", cmd: "teach" }, "en", userLang, origText, null);
    const out = await handleCmdTeach(sessionId, cleaned, userLang);
    await logReply(sessionId, "cmd", "teach", null, msgId, "trigger: teach");
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

  // ── 2) Имя/телефон
  const nameInThisMsg = detectAnyName(userTextRaw);
  const phone = detectPhone(userTextRaw);
  if (nameInThisMsg || phone) await updateContact(sessionId, { name: nameInThisMsg, phone });

  // ── 3) Сохраняем вход пользователя
  const userMsgId = await saveMessage(sessionId, "user", userTextEN, null, "en", userLang, origText, null);

  // ── 4) Кулдаун после TEACH: если следующее сообщение короткое — не эхоим KB
  const teachInfo = await getLastTeachInfo(sessionId);
  if (teachInfo) {
    const now = Date.now();
    const deltaSec = (now - teachInfo.ts.getTime()) / 1000;
    if (deltaSec < 90 && looksLikeShortAck(userTextRaw)) {
      const ack = userLang === "ru" ? "Принял. Идём дальше." :
                  userLang === "pl" ? "Przyjąłem. Idziemy dalej." :
                  userLang === "cz" ? "Rozumím. Pokračujme." :
                  userLang === "uk" ? "Прийняв. Рухаємося далі." :
                                      "Got it. Let’s proceed.";
      const { canonical } = await toEnglishCanonical(ack);
      await saveMessage(sessionId, "assistant", canonical, { category: "ack_after_teach", strategy: "cooldown_skip_kb", deltaSec }, "en", userLang, ack, "ack");
      return [ack];
    }
  }

  // ── 5) Если имени всё ещё нет — спросим, зеркалируя приветствие
  const session = await getSession(sessionId);
  const knownName = nameInThisMsg || session?.user_name?.trim();
  if (!knownName) {
    const ask = buildAskName(userLang, userTextRaw);
    const { canonical } = await toEnglishCanonical(ask);
    await saveMessage(sessionId, "assistant", canonical, { category: "ask_name", strategy: "precheck_name" }, "en", userLang, ask, "ask_name");
    return [ask];
  }

  // ── 6) KB → перевод → LLM
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

  // ── 6.1 Анти-эхо: если ответ из KB похож на последний taught_text — не подставляем
  if (answer && teachInfo?.taught_text && similar(answer, teachInfo.taught_text)) {
    answer = null;
    strategy = "skip_kb_echo";
  }

  // ── 6.2 Фолбэк
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

  return [answer];
}