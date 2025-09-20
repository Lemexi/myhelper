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

// Catalog helpers
// services.js exports:
// - findCatalogAnswer(rawText, userLang?) -> { answer, meta? } | null
// - enrichExpensiveAnswer(baseText, userLang?) -> string
// - getCatalogSnapshot() -> { sig, openCountries: string[] }
import { findCatalogAnswer, enrichExpensiveAnswer, getCatalogSnapshot } from "./services.js";

/* ───────────────── Internals ───────────────── */

async function replyCore(sessionId, userTextEN) {
  // Use only safe recent messages for LLM context
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

function buildAskName(rawText) {
  const hi = extractGreeting(rawText);
  // user-facing text in EN by default
  return `${hi ? hi + ". " : ""}May I have your name so I know how to address you?`;
}

/* ───────────────── Commands ───────────────── */

async function handleCmdTranslate(sessionId, rawText, userLangHint = "en") {
  const { targetLangWord, text } = parseCmdTranslate(rawText);
  const targetLang = (targetLangWord ? targetLangWord : "en").toLowerCase();

  if (!text || text.length < 2) {
    const msg = "Text is required after the 'Translate' command.";
    const { canonical } = await toEnglishCanonical(msg);
    await saveMessage(
      sessionId, "assistant", canonical,
      { category: "translate", strategy: "cmd_translate_error" },
      "en", userLangHint, msg, "translate"
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
`🔍 Translation (${tgt.toUpperCase()}):
${styled}

💬 RU helper:
${styledRu}`;

  const { canonical } = await toEnglishCanonical(combined);
  await saveMessage(
    sessionId, "assistant", canonical,
    { category: "translate", strategy: "cmd_translate" },
    "en", userLangHint, combined, "translate"
  );

  return combined;
}

async function handleCmdTeach(sessionId, rawText, userLangHint = "en") {
  const taught = parseCmdTeach(rawText);
  if (!taught) {
    const msg = "Text is required after 'Would answer…'.";
    const { canonical } = await toEnglishCanonical(msg);
    await saveMessage(
      sessionId, "assistant", canonical,
      { category: "teach", strategy: "cmd_teach_error" },
      "en", userLangHint, msg, "teach"
    );
    return msg;
  }
  const lastCat = (await getLastAuditCategory(sessionId)) || "general";
  const kbId = await kbInsertAnswer(lastCat, userLangHint || "en", taught, true);

  const out = `✅ Added to knowledge base.\n\n${taught}`;
  const { canonical } = await toEnglishCanonical(out);
  await saveMessage(
    sessionId, "assistant", canonical,
    { category: lastCat, strategy: "cmd_teach", kb_id: kbId },
    "en", userLangHint, out, lastCat
  );
  return out;
}

async function handleCmdAnswerExpensive(sessionId, userLangHint = "en") {
  const kb = (await kbFind("expensive", userLangHint)) || (await kbFind("expensive", "en"));
  let answer;
  if (kb?.answer) {
    answer = userLangHint !== "en"
      ? (await translateCached(kb.answer, "en", userLangHint)).text
      : kb.answer;
  } else {
    answer = await replyCore(
      sessionId,
      "Client says it's expensive. Give a brief WhatsApp-style response with value framing and a clear CTA."
    );
  }

  // Add factual ranges/prices from catalog if available
  try {
    answer = await enrichExpensiveAnswer(answer, userLangHint);
  } catch (_) { /* soft fallback */ }

  const { canonical } = await toEnglishCanonical(answer);
  await saveMessage(
    sessionId, "assistant", canonical,
    { category: "expensive", strategy: "cmd_answer_expensive" },
    "en", userLangHint, answer, "expensive"
  );
  await logReply(sessionId, "cmd", "expensive", kb?.id || null, null, "trigger: answer expensive");
  return answer;
}

/* ───────────────── Catalog helpers ───────────────── */

// Try to find the last saved catalog snapshot (from previous assistant replies)
async function loadLastCatalogSnapshotMeta(sessionId) {
  const recentRaw = await loadRecentMessages(sessionId, 40); // raw with meta fields
  if (!Array.isArray(recentRaw)) return null;

  // Look backwards for assistant message with meta.snapshot
  for (let i = recentRaw.length - 1; i >= 0; i--) {
    const m = recentRaw[i];
    if (m?.role !== "assistant") continue;
    const meta = (m?.meta_json) || m?.meta || null;
    if (meta && meta.snapshot && meta.snapshot.sig) {
      return meta.snapshot; // { sig, openCountries }
    }
  }
  return null;
}

// Compare old vs current and create a short change notice in EN
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
  // Check changes vs last snapshot for transparency
  const prevSnap = await loadLastCatalogSnapshotMeta(sessionId);
  const currentSnap = getCatalogSnapshot();

  const hit = await findCatalogAnswer(rawText, userLang);
  if (!hit || !hit.answer) return null;

  const { answer, meta } = hit;

  // If meta knows the country, use it for targeted notice
  const focusCountry = meta?.country || null;
  const notice = buildChangeNotice(prevSnap, currentSnap, focusCountry);

  const finalAnswer = notice ? `${notice}\n\n${answer}` : answer;

  const { canonical } = await toEnglishCanonical(finalAnswer);

  // Persist with meta including current snapshot for future diffs
  const metaToSave = Object.assign({}, meta || {}, { snapshot: currentSnap });

  await saveMessage(
    sessionId, "assistant", canonical,
    { category: "catalog", strategy: "catalog_hit", ...metaToSave },
    "en", userLang, finalAnswer, "catalog"
  );
  await logReply(sessionId, "catalog", "catalog", null, null, meta ? JSON.stringify(meta) : null);

  return finalAnswer;
}

/* ───────────────── SmartReply ───────────────── */

export async function smartReply(sessionKey, channel, userTextRaw, userLangHint = "en") {
  const sessionId = await upsertSession(sessionKey, channel);

  // Normalize input
  const { canonical: userTextEN, sourceLang: srcLang, original: origText } =
    await toEnglishCanonical(userTextRaw);
  const userLang = srcLang || userLangHint || "en";

  // Commands
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
    } else {
      const msg = "Text is required after the 'Translate' command.";
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
    const out = await handleCmdAnswerExpensive(sessionId, userLang);
    await logReply(sessionId, "cmd", "expensive", null, msgId, "trigger: answer expensive");
    return out;
  }

  // Name / phone updates
  const nameInThisMsg = detectAnyName(userTextRaw);
  const phone = detectPhone(userTextRaw);
  if (nameInThisMsg || phone) await updateContact(sessionId, { name: nameInThisMsg, phone });

  // Persist user message
  const userMsgId = await saveMessage(
    sessionId, "user", userTextEN,
    null, "en", userLang, origText, null
  );

  // Ask for name if unknown
  const session = await getSession(sessionId);
  const knownName = nameInThisMsg || session?.user_name?.trim();
  if (!knownName) {
    const ask = buildAskName(userTextRaw);
    const { canonical } = await toEnglishCanonical(ask);
    await saveMessage(
      sessionId, "assistant", canonical,
      { category: "ask_name", strategy: "precheck_name" },
      "en", userLang, ask, "ask_name"
    );
    return ask;
  }

  // Try answering from the services catalog first
  try {
    const catAns = await tryCatalogAnswer(sessionId, userTextRaw, userLang);
    if (catAns) return catAns;
  } catch (_) {
    // soft fallback
  }

  // KB → LLM fallback
  const category = await classifyCategory(userTextRaw);

  let kb = await kbFind(category, userLang);
  let answer, strategy = "fallback_llm", kbItemId = null;

  if (kb) {
    answer = kb.answer;
    strategy = "kb_hit";
    kbItemId = kb.id;
  } else {
    const kbEN = await kbFind(category, "en");
    if (kbEN) {
      answer = (await translateCached(kbEN.answer, "en", userLang)).text;
      strategy = "kb_translated";
      kbItemId = kbEN.id;
    }
  }

  if (!answer) {
    answer = await replyCore(sessionId, userTextEN);
    const detectedLLM = await detectLanguage(answer);
    if (detectedLLM && detectedLLM !== userLang) {
      answer = (await translateCached(answer, detectedLLM, userLang)).text;
    }
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