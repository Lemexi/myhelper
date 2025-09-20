// /src/reply.js
import { SYSTEM_PROMPT } from "./prompt.js";
import {
  upsertSession, updateContact, saveMessage, loadRecentMessages,
  loadLatestSummary, logReply, getLastAuditCategory, getSession,
  patchSessionMeta
} from "./db.js";
import { kbFind, kbInsertAnswer } from "./kb.js";
import {
  translateCached, translateWithStyle,
  toEnglishCanonical, detectLanguage
} from "./translator.js";
import {
  classifyCategory,
  detectPhone,
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
import {
  detectNameSmart,
  decideNextStep
} from "./orchestrator.js";

/* ───────────────── Settings ───────────────── */

const WHITELIST_LOCALES = new Set(["en", "ru", "pl", "cs", "cz"]);

function normLangCode(code) {
  const c = String(code || "").toLowerCase();
  if (c === "cz") return "cs";
  return c;
}

function langDisplayName(code) {
  const c = normLangCode(code);
  const map = { en: "English", ru: "Russian", pl: "Polish", cs: "Czech" };
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
    messages.push({ role: "system", content: `Brief recap of prior conversation:\n${summary}` });
  }
  messages.push(...recent);
  messages.push({ role: "user", content: userTextEN });

  const safe = messages.map(m => ({ role: m.role, content: m.content }));
  const { text } = await runLLM(safe);
  return text;
}

/* ───────────────── Name handling ───────────────── */

function buildAskName(rawText, outLang) {
  const hi = extractGreeting(rawText);
  const by = {
    en: `${hi ? hi + ". " : ""}Hello, my name is Viktor Shimansky, general manager at RenovoGo.com. May I know your name so I can address you properly?`,
    ru: `${hi ? hi + ". " : ""}Здравствуйте, меня зовут Виктор Шиманский, я генеральный менеджер компании RenovoGo.com. Подскажите, пожалуйста, как вас зовут?`,
    pl: `${hi ? hi + ". " : ""}Dzień dobry, nazywam się Viktor Shimansky, jestem dyrektorem generalnym w RenovoGo.com. Jak ma Pan/Pani na imię?`,
    cs: `${hi ? hi + ". " : ""}Dobrý den, jmenuji se Viktor Shimansky, generální manažer RenovoGo.com. Můžu se zeptat, jak se jmenujete?`
  };
  return by[normLangCode(outLang)] || by.en;
}

/* ───────────────── Language behavior ───────────────── */

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
  if (WHITELIST_LOCALES.has(outLang)) {
    if (outLang === "en") return { finalText: textEN, metaExtra: {} };
    const localized = (await translateCached(textEN, "en", outLang)).text;
    return { finalText: localized, metaExtra: {} };
  }
  const warned = await getWarnedLangs(sessionId);
  const alreadyWarned = warned.has(outLang);
  const localized = (await translateCached(textEN, "en", outLang)).text;

  if (!prependNoticeIfNeeded || alreadyWarned) {
    return { finalText: localized, metaExtra: {} };
  }

  const noticeEN = `Heads up: we don’t speak ${langDisplayName(outLang)} natively, so for quality we’ll use a translator.`;
  const finalText = `${noticeEN}\n\n${localized}`;
  return { finalText, metaExtra: { translator_notice_for: [outLang] } };
}

/* ───────────────── Admin commands ───────────────── */

async function handleCmdTranslate(sessionId, rawText, userLang = "ru") {
  const { targetLangWord, text } = parseCmdTranslate(rawText);
  const targetLang = (targetLangWord ? targetLangWord : "en").toLowerCase();

  if (!text || text.length < 2) {
    const msg = "Нужен текст после команды «Переведи».";
    const { canonical } = await toEnglishCanonical(msg);
    await saveMessage(sessionId, "assistant", canonical,
      { category: "translate", strategy: "cmd_translate_error" },
      "en", userLang, msg, "translate");
    return msg;
  }

  const { targetLang: tgt, styled, styledRu } =
    await translateWithStyle({ sourceText: text, targetLang, style: "influence_psychology_marketing_neurocopy" });

  const combined =
`🔍 Перевод (${tgt.toUpperCase()}):
${styled}

💬 Для тебя (RU):
${styledRu}`;

  const { canonical } = await toEnglishCanonical(combined);
  await saveMessage(sessionId, "assistant", canonical,
    { category: "translate", strategy: "cmd_translate" },
    "en", userLang, combined, "translate");
  return combined;
}

async function handleCmdTeach(sessionId, rawText, userLang = "ru") {
  const taught = parseCmdTeach(rawText);
  if (!taught) {
    const msg = "Нужен текст после «Ответил бы».";
    const { canonical } = await toEnglishCanonical(msg);
    await saveMessage(sessionId, "assistant", canonical,
      { category: "teach", strategy: "cmd_teach_error" },
      "en", userLang, msg, "teach");
    return msg;
  }
  const lastCat = (await getLastAuditCategory(sessionId)) || "general";
  const kbId = await kbInsertAnswer(lastCat, userLang || "ru", taught, true);

  const out = `✅ В базу добавлено.\n\n${taught}`;
  const { canonical } = await toEnglishCanonical(out);
  await saveMessage(sessionId, "assistant", canonical,
    { category: lastCat, strategy: "cmd_teach", kb_id: kbId },
    "en", userLang, out, lastCat);
  return out;
}

async function handleCmdAnswerExpensive(sessionId, userLang = "ru") {
  const kb = (await kbFind("expensive", userLang)) || (await kbFind("expensive", "ru"));
  let answer;
  if (kb?.answer) {
    answer = userLang !== "ru" ? (await translateCached(kb.answer, "ru", userLang)).text : kb.answer;
  } else {
    answer = await replyCore(
      sessionId,
      "Клиент говорит, что это дорого. Дай короткий ответ в стиле WhatsApp на русском с акцентом на ценность и чётким CTA."
    );
  }

  try {
    const enrichedEN = await enrichExpensiveAnswer(answer, "en");
    const detected = await detectLanguage(enrichedEN);
    if (detected !== "ru") {
      answer = (await translateCached(enrichedEN, detected || "en", "ru")).text;
    } else {
      answer = enrichedEN;
    }
  } catch (_) {}

  const { canonical } = await toEnglishCanonical(answer);
  await saveMessage(sessionId, "assistant", canonical,
    { category: "expensive", strategy: "cmd_answer_expensive" },
    "en", userLang, answer, "expensive");
  await logReply(sessionId, "cmd", "expensive", kb?.id || null, null, "trigger: answer expensive");
  return answer;
}

/* ───────────────── SmartReply ───────────────── */

export async function smartReply(sessionKey, channel, userTextRaw, userLangHint = "en") {
  const sessionId = await upsertSession(sessionKey, channel);

  const { canonical: userTextEN, sourceLang: srcLang, original: origText } =
    await toEnglishCanonical(userTextRaw);
  const userLang = normLangCode(srcLang || userLangHint || "en");

  // Admin commands
  if (isCmdTeach(userTextRaw)) return handleCmdTeach(sessionId, userTextRaw, "ru");
  if (isCmdTranslate(userTextRaw)) return handleCmdTranslate(sessionId, userTextRaw, "ru");
  if (isCmdAnswerExpensive(userTextRaw)) return handleCmdAnswerExpensive(sessionId, "ru");

  // Session info
  const session = await getSession(sessionId);

  // Name detection
  const nameInfo = await detectNameSmart(userTextRaw, session?.user_name?.trim() || null);
  if (nameInfo?.name && nameInfo.name !== session?.user_name) {
    await updateContact(sessionId, { name: nameInfo.name });
    return `Очень приятно познакомиться, ${nameInfo.name}. Чем могу помочь?`;
  }

  // If no name known
  if (!session?.user_name) {
    const askEN = buildAskName(userTextRaw, userLang);
    return askEN;
  }

  // Main logic — free flow + orchestrator nudge
  let step = null;
  try {
    step = await decideNextStep({ session, text: userTextRaw, snapshot: getCatalogSnapshot() });
    if (step?.nudgeEN) {
      const coreEN = await replyCore(sessionId, userTextEN);
      return `${coreEN}\n\n${step.nudgeEN}`;
    }
  } catch (_) {}

  // KB → fallback
  let kb = await kbFind(await classifyCategory(userTextRaw), "en");
  let answerEN = kb ? kb.answer : await replyCore(sessionId, userTextEN);

  const { finalText } = await localizeForUser({
    sessionId, userLang, textEN: answerEN, prependNoticeIfNeeded: true
  });
  return finalText;
}