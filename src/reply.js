// /src/reply.js
import {
  upsertSession, updateContact, saveMessage, loadRecentMessages,
  loadLatestSummary, logReply, getLastAuditCategory, getSession, pool
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
  isCmdAnswerExpensive
} from "./classifier.js";

import { runLLM } from "./llm.js";
import { buildSystemPrompt, buildMessages } from "./prompt.js";
import { ensureName, upsertFacts, getSessionProfile } from "./memory.js";
import { fetchRecentSummaries } from "./summaries.js";
import { maybeUpdateStyle } from "./style.js";
import { saveUserQuestion, findAnswerFromKB } from "./qna.js";

// ▶ Playbook: этапы диалога и извлечение фактов
import { DIRECT_LANGS, handleByStage, inferQuickFacts } from "./playbook.js";

/* ─────────────────────────────────────────────────────────────
 * Language policy (EN/RU/PL/CS напрямую; прочие → EN + notice)
 * ────────────────────────────────────────────────────────────*/

const SUPPORTED = new Set(DIRECT_LANGS); // ['en','ru','pl','cs']

function normLang(l) {
  if (!l) return "en";
  const s = l.toLowerCase();
  if (s.startsWith("cz")) return "cs";
  if (s.startsWith("uk")) return "uk";
  return s.slice(0, 2);
}
function chooseConvLang(sourceLang) {
  const L = normLang(sourceLang);
  return SUPPORTED.has(L) ? L : "en";
}
function askSwitchLang(text) {
  const t = (text || "").toLowerCase();
  return /не понимаю|не понял|не поняла|can we speak|speak .*|можно на|переход.*на/i.test(t);
}
function extractRequestedLang(text) {
  const t = (text || "").toLowerCase();
  if (/рус|russian/i.test(t)) return "ru";
  if (/pol(?:ish|sku)?|po polsku/i.test(t)) return "pl";
  if (/czech|cesk|čes|po čes/i.test(t)) return "cs";
  if (/english|англ/i.test(t)) return "en";
  if (/arab|араб/i.test(t)) return "ar";
  if (/hebr|иврит/i.test(t)) return "he";
  if (/ukrain/i.test(t)) return "uk";
  return null;
}

// Перевод финального EN-ответа в язык диалога при необходимости
async function finalizeOut(textEN, convLang) {
  if (!textEN) return "";
  if (convLang === "en") return textEN;
  const detected = await detectLanguage(textEN);
  if (detected === convLang) return textEN;
  const from = (detected && ["en", "ru", "pl", "cs", "uk"].includes(detected)) ? detected : "en";
  return (await translateCached(textEN, from, convLang)).text;
}

/* ─────────────────────────────────────────────────────────────
 * LLM fallback (история + системка всегда на EN)
 * ────────────────────────────────────────────────────────────*/

async function llmFallbackReply(sessionId, userTextEN, _lang, promptExtras = {}) {
  const recentRaw = await loadRecentMessages(sessionId, 18);
  const recent = (recentRaw || [])
    .map(m => ({ role: m.role, content: String(m.content ?? "") }))
    .filter(m => m.role && m.content);

  const summaries = await fetchRecentSummaries(sessionId, 3);
  const profile   = await getSessionProfile(sessionId);

  const system = buildSystemPrompt({
    profile,
    summaries,
    facts: {
      user_name: profile?.user_name,
      country_interest: profile?.country_interest,
      intent_main: profile?.intent_main,
      candidates_planned: profile?.candidates_planned,
      stage: profile?.stage,
      psychotype: profile?.psychotype,
      ...promptExtras
    },
    locale: "en"
  });

  const msgs = buildMessages({ system, userText: userTextEN });
  const safe = [msgs[0], ...recent, msgs[1]].map(m => ({ role: m.role, content: m.content }));
  const { text } = await runLLM(safe);
  return text;
}

/* ─────────────────────────────────────────────────────────────
 * Commands
 * ────────────────────────────────────────────────────────────*/

async function handleCmdTranslate(sessionId, rawText, userLang = "ru") {
  const { targetLangWord, text } = parseCmdTranslate(rawText);
  const targetLang = (targetLangWord || "en").toLowerCase();

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
    await translateWithStyle({ sourceText: text, targetLang });

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
    answer = await llmFallbackReply(
      sessionId,
      "Client says it's expensive. Give a brief WhatsApp-style response with value framing and a clear CTA.",
      "en"
    );
  }
  const { canonical } = await toEnglishCanonical(answer);
  await saveMessage(
    sessionId, "assistant", canonical,
    { category: "expensive", strategy: "cmd_answer_expensive" },
    "en", userLang, answer, "expensive"
  );
  await logReply(sessionId, "cmd", "expensive", kb?.id || null, null, "trigger: answer expensive");
  return answer;
}

/* ─────────────────────────────────────────────────────────────
 * Category router (KB exact → KB category → LLM)
 * ────────────────────────────────────────────────────────────*/

async function routeByCategory({ category, sessionId, userLang, userTextEN, userMsgId }) {
  // 1) QnA exact
  const kbExact = await findAnswerFromKB(userTextEN, 0.9);
  if (kbExact) {
    const { canonical } = await toEnglishCanonical(kbExact);
    await logReply(sessionId, "kb_exact", category, null, userMsgId, "qna exact");
    await saveMessage(
      sessionId, "assistant", canonical,
      { category, strategy: "kb_exact" },
      "en", userLang, kbExact, category
    );
    return kbExact;
  }

  // 2) Category KB
  let kb = await kbFind(category, userLang);
  let answer = null;
  let strategy = "fallback_llm";
  let kbItemId = null;

  if (kb?.answer) {
    answer = kb.answer;
    strategy = "kb_hit";
    kbItemId = kb.id;
  } else {
    const kbRu = await kbFind(category, "ru");
    if (kbRu?.answer) {
      answer = (await translateCached(kbRu.answer, "ru", userLang)).text;
      strategy = "kb_translated";
      kbItemId = kbRu.id;
    }
  }

  // 3) LLM
  if (!answer) {
    const draftEN = await llmFallbackReply(sessionId, userTextEN, "en");
    answer = await finalizeOut(draftEN, userLang);
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

/* ─────────────────────────────────────────────────────────────
 * SMART REPLY (главный вход)
 * ────────────────────────────────────────────────────────────*/

export async function smartReply(sessionKey, channel, userTextRaw, _userLangHint = "ru", extra = {}) {
  const sessionId = await upsertSession(sessionKey, channel);

  // 0) Канонизация входа → EN
  const { canonical: userTextEN, sourceLang: srcLang, original: origText } =
    await toEnglishCanonical(userTextRaw);

  // 1) Базовый язык диалога
  let convLang = chooseConvLang(srcLang);

  // 1.1) Явный запрос пользователя на переключение языка
  if (askSwitchLang(userTextRaw)) {
    const want = extractRequestedLang(userTextRaw);
    if (want) {
      if (SUPPORTED.has(want)) {
        convLang = want;
      } else {
        convLang = want;
        const note =
          convLang === "ru" ? "Переключаюсь. Я буду использовать переводчик, чтобы сохранить точность."
        : convLang === "pl" ? "Przełączam się. Użyję tłumacza, żeby zachować dokładność."
        : convLang === "cs" ? "Přepínám se. Pro přesnost použiji překladač."
        : "Switching language. I will use a translator to keep it accurate.";
        const { canonical } = await toEnglishCanonical(note);
        await saveMessage(
          sessionId, "assistant", canonical,
          { category: "lang_switch", strategy: "translator_notice", to: convLang },
          "en", convLang, note, "lang_switch"
        );
        return note;
      }
    }
  }

  // 2) Команды
  if (isCmdTeach(userTextRaw)) {
    const msgId = await saveMessage(
      sessionId, "user", userTextEN,
      { kind: "cmd_detected", cmd: "teach" },
      "en", convLang, origText, null
    );
    const out = await handleCmdTeach(sessionId, userTextRaw, convLang);
    await logReply(sessionId, "cmd", "teach", null, msgId, "trigger: teach");
    return out;
  }
  if (isCmdTranslate(userTextRaw)) {
    const { text: t } = parseCmdTranslate(userTextRaw);
    if (t && t.length >= 2) {
      const msgId = await saveMessage(
        sessionId, "user", userTextEN,
        { kind: "cmd_detected", cmd: "translate" },
        "en", convLang, origText, null
      );
      const out = await handleCmdTranslate(sessionId, userTextRaw, convLang);
      await logReply(sessionId, "cmd", "translate", null, msgId, "trigger: translate");
      return out;
    }
  }
  if (isCmdAnswerExpensive(userTextRaw)) {
    const msgId = await saveMessage(
      sessionId, "user", userTextEN,
      { kind: "cmd_detected", cmd: "answer_expensive" },
      "en", convLang, origText, null
    );
    const out = await handleCmdAnswerExpensive(sessionId, convLang);
    await logReply(sessionId, "cmd", "expensive", null, msgId, "trigger: answer expensive");
    return out;
  }

  // 3) Контакт и быстрые факты
  const nameInThisMsg = detectAnyName(userTextRaw);
  const phone = detectPhone(userTextRaw);
  if (nameInThisMsg || phone) await updateContact(sessionId, { name: nameInThisMsg, phone });
  await ensureName(sessionId, userTextRaw, extra?.tgMeta);

  // извлекаем факты из сырого и канонического текста
  const facts = inferQuickFacts((userTextRaw || "") + "\n" + (userTextEN || ""));

  // резервные русские ключи (если вдруг не распознало)
  if (!facts.country_interest) {
    if (/чех/i.test(userTextRaw)) facts.country_interest = "CZ";
    if (/польш/i.test(userTextRaw)) facts.country_interest = "PL";
  }
  const n = userTextRaw.match(/\b(\d{1,3})\s*(кандидат|люд)/i)?.[1];
  if (n && !facts.candidates_planned) facts.candidates_planned = Number(n);

  if (Object.keys(facts).length) await upsertFacts(sessionId, facts);

  // 4) Лог входа + QnA трекинг
  const userMsgId = await saveMessage(
    sessionId, "user", userTextEN,
    null, "en", convLang, origText, null
  );
  await saveUserQuestion(sessionId, userTextEN);

  // 5) Обновить стиль и получить персону
  await maybeUpdateStyle(sessionId);
  const profile = await getSessionProfile(sessionId);
  const persona = profile?.psychotype || "default";

  // 6) Лёгкий оффтоп (машины) — кратко и обратно к делу
  if (/машин|автомобил|cars?/i.test(userTextRaw)) {
    const short = (convLang === "ru")
      ? "Коротко: по машинам могу подсказать, но наш фокус — легальное трудоустройство. Вернёмся к кандидатам? Какая страна и ставка?"
      : "Brief: I can comment on cars, but our focus is legal job placement. Back to candidates? Which country and salary?";
    const { canonical } = await toEnglishCanonical(short);
    await saveMessage(
      sessionId, "assistant", canonical,
      { category: "offtopic", strategy: "brief_then_return" },
      "en", convLang, short, "offtopic"
    );
    return short;
  }

  // 7) ▶ Сначала пробуем stage playbook (intro → discovery → demo → specifics)
  const stageOut = await handleByStage({
    sessionId,
    userTextEN,
    convLang,
    persona
  });

  if (stageOut && stageOut.textEN) {
    const final = await finalizeOut(stageOut.textEN, convLang);
    const { canonical: ansEN } = await toEnglishCanonical(final);
    await saveMessage(
      sessionId, "assistant", ansEN,
      { category: stageOut.stage || "stage", strategy: stageOut.strategy || "playbook" },
      "en", convLang, final, stageOut.stage || "stage"
    );
    await logReply(sessionId, stageOut.strategy || "playbook", stageOut.stage || "stage", null, userMsgId, "playbook");
    return final;
  }

  // 8) Если плейбук не сработал — обычный роутер (KB/LLM)
  const category = await classifyCategory(userTextRaw);
  switch (category) {
    case "greeting":
    case "smalltalk":
    case "general":
    case "visa":
    case "work":
    case "business":
    case "docs":
    case "price":
    case "timeline":
    case "process":
    case "expensive":
    default:
      return await routeByCategory({ category, sessionId, userLang: convLang, userTextEN, userMsgId });
  }
}