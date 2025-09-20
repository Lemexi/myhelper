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

import {
  findCatalogAnswer,
  enrichExpensiveAnswer,
  getCatalogSnapshot
} from "./services.js";

/* ───────────────── Settings ───────────────── */

// Языки без предупреждения про переводчик:
const WHITELIST_LOCALES = new Set(["en", "ru", "pl", "cs", "cz"]);

// Нормализация кода языка (cs/cz -> cs)
function normLangCode(code) {
  const c = String(code || "").toLowerCase();
  if (c === "cz") return "cs";
  return c;
}

function langDisplayName(code) {
  const c = normLangCode(code);
  const map = {
    en: "English",
    ru: "Russian",
    pl: "Polish",
    cs: "Czech"
  };
  return map[c] || c.toUpperCase();
}

/* ───────────────── Core helpers ───────────────── */

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
      content: `Brief recap of prior conversation:\n${summary}`
    });
  }
  messages.push(...recent);
  messages.push({ role: "user", content: userTextEN });

  const safe = messages.map(m => ({ role: m.role, content: m.content }));
  const { text } = await runLLM(safe);
  return text;
}

function buildAskName(rawText, outLang) {
  const hi = extractGreeting(rawText);
  const by = {
    en: `${hi ? hi + ". " : ""}May I have your name so I know how to address you?`,
    ru: `${hi ? hi + ". " : ""}Подскажите, пожалуйста, как вас зовут, чтобы я знал, как к вам обращаться?`,
    pl: `${hi ? hi + ". " : ""}Proszę podpowiedzieć, jak ma Pan/Pani na imię, żebym wiedział, jak się zwracać?`,
    cs: `${hi ? hi + ". " : ""}Mohu poprosit o vaše jméno, abych věděl, jak vás oslovovat?`
  };
  return by[normLangCode(outLang)] || by.en;
}

/* ───────────────── Language behavior ───────────────── */

// Однократное предупреждение про «используем переводчик»
async function getWarnedLangs(sessionId) {
  const recentRaw = await loadRecentMessages(sessionId, 50);
  const warned = new Set();
  if (!Array.isArray(recentRaw)) return warned;
  for (const m of recentRaw) {
    if (m?.role !== "assistant") continue;
    const meta = m?.meta_json || m?.meta || null;
    if (meta && Array.isArray(meta.translator_notice_for)) {
      for (const x of meta.translator_notice_for) warned.add(normLangCode(x));
    }
  }
  return warned;
}

function detectLangProbeQuestion(userTextRaw) {
  const t = String(userTextRaw || "").toLowerCase();
  return (
    /what\s+languages\s+(do\s+you\s+)?(speak|know)/i.test(t) ||
    /какие\s+языки\s+ты\s+(зна(е|ё)шь|знаешь)/i.test(t) ||
    /на\s+каких\s+языках\s+(ты\s+)?(говоришь|общаешься)/i.test(t) ||
    /jakimi\s+językami\s+(mówisz|operujesz)/i.test(t) ||
    /jakými\s+jazyky\s+(mluvíš|ovládáš)/i.test(t)
  );
}

async function localizeForUser({ sessionId, userLang, textEN, prependNoticeIfNeeded = true }) {
  const outLang = normLangCode(userLang || "en");
  // Если язык в белом списке — просто переводим/оставляем EN.
  if (WHITELIST_LOCALES.has(outLang)) {
    if (outLang === "en") return { finalText: textEN, metaExtra: {} };
    const localized = (await translateCached(textEN, "en", outLang)).text;
    return { finalText: localized, metaExtra: {} };
  }

  // Язык вне белого списка — проверяем, предупреждали ли ранее
  const warned = await getWarnedLangs(sessionId);
  const alreadyWarned = warned.has(outLang);
  const localized = (await translateCached(textEN, "en", outLang)).text;

  if (!prependNoticeIfNeeded || alreadyWarned) {
    return { finalText: localized, metaExtra: {} };
  }

  const noticeEN = `Heads up: we don’t speak ${langDisplayName(outLang)} natively, so for quality we’ll use a translator. We can continue in your language.`;
  const finalText = `${noticeEN}\n\n${localized}`;
  return { finalText, metaExtra: { translator_notice_for: [outLang] } };
}

/* ───────────────── Admin commands (RU only) ───────────────── */

async function handleCmdTranslate(sessionId, rawText, userLang = "ru") {
  const { targetLangWord, text } = parseCmdTranslate(rawText);
  const targetLang = (targetLangWord ? targetLangWord : "en").toLowerCase();

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
    await translateWithStyle({
      sourceText: text,
      targetLang,
      style: "influence_psychology_marketing_neurocopy"
    });

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
      "Клиент говорит, что это дорого. Дай короткий ответ в стиле WhatsApp на русском с акцентом на ценность и чётким CTA."
    );
  }

  // Обогатим фактами каталога (services вернет EN → переведем в RU)
  try {
    const enrichedEN = await enrichExpensiveAnswer(answer, "en");
    const detected = await detectLanguage(enrichedEN);
    if (detected !== "ru") {
      answer = (await translateCached(enrichedEN, detected || "en", "ru")).text;
    } else {
      answer = enrichedEN;
    }
  } catch (_) { /* soft fallback */ }

  const { canonical } = await toEnglishCanonical(answer);
  await saveMessage(
    sessionId, "assistant", canonical,
    { category: "expensive", strategy: "cmd_answer_expensive" },
    "en", userLang, answer, "expensive"
  );
  await logReply(sessionId, "cmd", "expensive", kb?.id || null, null, "trigger: answer expensive");
  return answer;
}

/* ───────────────── Catalog (user answers generated EN → localized) ───────────────── */

async function loadLastCatalogSnapshotMeta(sessionId) {
  const recentRaw = await loadRecentMessages(sessionId, 40);
  if (!Array.isArray(recentRaw)) return null;
  for (let i = recentRaw.length - 1; i >= 0; i--) {
    const m = recentRaw[i];
    if (m?.role !== "assistant") continue;
    const meta = (m?.meta_json) || m?.meta || null;
    if (meta && meta.snapshot && meta.snapshot.sig) return meta.snapshot;
  }
  return null;
}

function buildChangeNotice(prevSnap, currentSnap, focusCountry) {
  if (!prevSnap || !currentSnap || prevSnap.sig === currentSnap.sig) return null;

  const prevOpen = new Set((prevSnap.openCountries || []).map(c => c.toUpperCase()));
  const currOpen = new Set((currentSnap.openCountries || []).map(c => c.toUpperCase()));

  const opened = [...currOpen].filter(c => !prevOpen.has(c));
  const closed = [...prevOpen].filter(c => !currOpen.has(c));

  const parts = [];
  if (focusCountry) {
    const C = String(focusCountry).toUpperCase();
    if (prevOpen.has(C) && !currOpen.has(C)) parts.push(`Heads up: ${C} is currently closed.`);
    if (!prevOpen.has(C) && currOpen.has(C)) parts.push(`Good news: ${C} is open now.`);
  } else {
    if (opened.length) parts.push(`Newly open: ${opened.join(", ")}.`);
    if (closed.length) parts.push(`Now closed: ${closed.join(", ")}.`);
  }
  if (!parts.length) return null;
  return `🔄 Updates since your last visit:\n${parts.join(" ")}`;
}

async function tryCatalogAnswer(sessionId, rawText, userLang) {
  const prevSnap = await loadLastCatalogSnapshotMeta(sessionId);
  const currentSnap = getCatalogSnapshot();

  const hit = await findCatalogAnswer(rawText, "en");
  if (!hit || !hit.answer) return null;

  const { answer, meta } = hit;
  const focusCountry = meta?.country || null;
  const noticeEN = buildChangeNotice(prevSnap, currentSnap, focusCountry);
  const stitchedEN = noticeEN ? `${noticeEN}\n\n${answer}` : answer;

  // Локализуем по правилам (возможное одноразовое предупреждение)
  const { finalText, metaExtra } = await localizeForUser({
    sessionId, userLang, textEN: stitchedEN, prependNoticeIfNeeded: true
  });

  const { canonical } = await toEnglishCanonical(finalText);
  const metaToSave = Object.assign({}, meta || {}, { snapshot: currentSnap }, metaExtra || null);

  await saveMessage(
    sessionId, "assistant", canonical,
    { category: "catalog", strategy: "catalog_hit", ...metaToSave },
    "en", userLang, finalText, "catalog"
  );
  await logReply(sessionId, "catalog", "catalog", null, null, meta ? JSON.stringify(meta) : null);

  return finalText;
}

/* ───────────────── SmartReply ───────────────── */

export async function smartReply(sessionKey, channel, userTextRaw, userLangHint = "en") {
  const sessionId = await upsertSession(sessionKey, channel);

  // Канонизируем вход, получаем исходный язык пользователя
  const { canonical: userTextEN, sourceLang: srcLang, original: origText } =
    await toEnglishCanonical(userTextRaw);
  const userLang = normLangCode(srcLang || userLangHint || "en");

  // Если пользователь спрашивает "какие языки знаешь" — отвечаем минимально, без списка
  if (detectLangProbeQuestion(userTextRaw)) {
    const msgEN = `I’m communicating with you in ${langDisplayName(userLang)}. Is this okay for you?`;
    const { finalText } = await localizeForUser({
      sessionId, userLang, textEN: msgEN, prependNoticeIfNeeded: true
    });
    const { canonical } = await toEnglishCanonical(finalText);
    await saveMessage(
      sessionId, "assistant", canonical,
      { category: "smalltalk", strategy: "lang_probe" },
      "en", userLang, finalText, "smalltalk"
    );
    return finalText;
  }

  // АДМИН-КОМАНДЫ (всегда RU)
  if (isCmdTeach(userTextRaw)) {
    const msgId = await saveMessage(
      sessionId, "user", userTextEN,
      { kind: "cmd_detected", cmd: "teach" },
      "en", userLang, origText, null
    );
    const out = await handleCmdTeach(sessionId, userTextRaw, "ru");
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
      const out = await handleCmdTranslate(sessionId, userTextRaw, "ru");
      await logReply(sessionId, "cmd", "translate", null, msgId, "trigger: translate");
      return out;
    } else {
      const msg = "Нужен текст после команды «Переведи».";
      const { canonical } = await toEnglishCanonical(msg);
      await saveMessage(
        sessionId, "assistant", canonical,
        { category: "translate", strategy: "cmd_translate_error" },
        "en", userLang, msg, "translate"
      );
      return msg;
    }
  }

  if (isCmdAnswerExpensive(userTextRaw)) {
    const msgId = await saveMessage(
      sessionId, "user", userTextEN,
      { kind: "cmd_detected", cmd: "answer_expensive" },
      "en", userLang, origText, null
    );
    const out = await handleCmdAnswerExpensive(sessionId, "ru");
    await logReply(sessionId, "cmd", "expensive", null, msgId, "trigger: answer expensive");
    return out;
  }

  // Имя / телефон в контакт
  const nameInThisMsg = detectAnyName(userTextRaw);
  const phone = detectPhone(userTextRaw);
  if (nameInThisMsg || phone) await updateContact(sessionId, { name: nameInThisMsg, phone });

  // Сохраняем вход пользователя
  const userMsgId = await saveMessage(
    sessionId, "user", userTextEN,
    null, "en", userLang, origText, null
  );

  // Если имени нет — спросим (локализуем)
  const session = await getSession(sessionId);
  const knownName = nameInThisMsg || session?.user_name?.trim();
  if (!knownName) {
    const askEN = buildAskName(userTextRaw, "en"); // шаблонный EN
    const { finalText } = await localizeForUser({
      sessionId, userLang, textEN: askEN, prependNoticeIfNeeded: true
    });
    const { canonical } = await toEnglishCanonical(finalText);
    await saveMessage(
      sessionId, "assistant", canonical,
      { category: "ask_name", strategy: "precheck_name" },
      "en", userLang, finalText, "ask_name"
    );
    return finalText;
  }

  // 1) Пытаемся ответить из каталога (EN → локализация)
  try {
    const catAns = await tryCatalogAnswer(sessionId, userTextRaw, userLang);
    if (catAns) return catAns;
  } catch (_) { /* soft fallback */ }

  // 2) KB → LLM
  const category = await classifyCategory(userTextRaw);

  let kb = await kbFind(category, "en");
  let answerEN, strategy = "fallback_llm", kbItemId = null;

  if (kb) {
    answerEN = kb.answer;
    strategy = "kb_hit";
    kbItemId = kb.id;
  } else {
    // позволяем RU KB, если нет EN
    const kbRu = await kbFind(category, "ru");
    if (kbRu) {
      answerEN = (await translateCached(kbRu.answer, "ru", "en")).text;
      strategy = "kb_translated";
      kbItemId = kbRu.id;
    }
  }

  if (!answerEN) {
    // генерим EN → потом локализуем
    answerEN = await replyCore(sessionId, userTextEN);
    const detectedLLM = await detectLanguage(answerEN);
    if (detectedLLM && detectedLLM !== "en") {
      answerEN = (await translateCached(answerEN, detectedLLM, "en")).text;
    }
  }

  const { finalText } = await localizeForUser({
    sessionId, userLang, textEN: answerEN, prependNoticeIfNeeded: true
  });

  const { canonical: ansEN } = await toEnglishCanonical(finalText);
  await logReply(sessionId, strategy, category, kbItemId, userMsgId, null);
  await saveMessage(
    sessionId, "assistant", ansEN,
    { category, strategy },
    "en", userLang, finalText, category
  );

  return finalText;
}