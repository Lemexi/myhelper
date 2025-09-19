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
  isCmdAnswerExpensive, extractGreeting
} from "./classifier.js";

import { runLLM } from "./llm.js";

import { buildSystemPrompt, buildMessages } from "./prompt.js";
import { ensureName, upsertFacts, getSessionProfile } from "./memory.js";
import { fetchRecentSummaries } from "./summaries.js";
import { maybeUpdateStyle } from "./style.js";
import { saveUserQuestion, findAnswerFromKB } from "./qna.js";

/* ─────────────────────────────────────────────────────────────
 * ВСПОМОГАТЕЛЬНОЕ
 * ────────────────────────────────────────────────────────────*/

// Персонификация коротких просьб
function personaReply(persona, shortAnswer, cta) {
  const T = {
    commander: (ans, c) => `${ans ? ans + '\n' : ''}План: ${c || 'Страна, позиция, ставка — и двигаемся.'}`,
    diplomat:  (ans, c) => `${ans ? ans + '\n' : ''}Точно и по делу: ${c || 'уточните страну/позицию/ставку.'}`,
    humanist:  (ans, c) => `${ans ? 'Понимаю. ' + ans + '\n' : ''}Сделаю аккуратно — ${c || 'подскажите детали, продолжим.'}`,
    star:      (ans, c) => `${ans ? ans + '\n' : ''}Коротко: ${c || 'страна и ставка — и вперёд.'}`,
    default:   (ans, c) => `${ans ? ans + '\n' : ''}${c || 'Пожалуйста, страна, позиция и ставка.'}`
  };
  return (T[persona] || T.default)(shortAnswer, cta);
}

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

// ЯЗЫК: поддерживаем RU/PL/CS/EN. Иначе — EN.
// Если пользователь просит другой (не понимает) — переключаемся;
// если язык вне RU/PL/CS/EN — честно говорим, что используем переводчик.
const SUPPORTED = new Set(['ru', 'pl', 'cs', 'en']);

function normLang(l) {
  if (!l) return 'en';
  const s = l.toLowerCase();
  if (s.startsWith('cz')) return 'cs';
  if (s.startsWith('uk')) return 'uk';
  return s.slice(0,2);
}

function chooseConvLang(sourceLang) {
  const L = normLang(sourceLang);
  return SUPPORTED.has(L) ? L : 'en';
}

function askSwitchLang(text) {
  const t = (text || '').toLowerCase();
  return /не понимаю|не понял|не поняла|can we speak|speak .*|можно на|переход.*на/i.test(t);
}

function extractRequestedLang(text) {
  const t = (text || '').toLowerCase();
  if (/рус|russian/i.test(t)) return 'ru';
  if (/pol(?:ish|sku)?|po polsku/i.test(t)) return 'pl';
  if (/czech|cesk|čes|po čes/i.test(t)) return 'cs';
  if (/english|англ/i.test(t)) return 'en';
  // любое другое — пробуем вытащить ISO-код (например, arabic/hebrew/etc.)
  if (/arab|араб/i.test(t)) return 'ar';
  if (/hebr|иврит/i.test(t)) return 'he';
  if (/ukrain/i.test(t)) return 'uk';
  return null;
}

async function llmFallbackReply(sessionId, userTextEN, lang, promptExtras = {}) {
  const recentRaw = await loadRecentMessages(sessionId, 18);
  const recent = (recentRaw || [])
    .map(m => ({ role: m.role, content: String(m.content ?? "") }))
    .filter(m => m.role && m.content);

  const summaries = await fetchRecentSummaries(sessionId, 3);
  const profile   = await getSessionProfile(sessionId);
  const system    = buildSystemPrompt({
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
    locale: lang
  });

  const msgs = buildMessages({ system, userText: userTextEN });
  const safe = [msgs[0], ...recent, msgs[1]].map(m => ({ role: m.role, content: m.content }));
  const { text } = await runLLM(safe);
  return text;
}

/* ─────────────────────────────────────────────────────────────
 * УЧЁТ «ЧТО УЖЕ СПРАШИВАЛИ» (anti-repeat)
 * ────────────────────────────────────────────────────────────*/

async function getAskedState(sessionId) {
  const { rows } = await pool.query(
    `SELECT asked_fields, asked_attempts FROM public.sessions WHERE id=$1`,
    [sessionId]
  );
  const s = rows[0] || {};
  return {
    fields: s.asked_fields || {},
    attempts: s.asked_attempts || {}
  };
}

async function setAsked(sessionId, field) {
  const { fields, attempts } = await getAskedState(sessionId);
  const nextFields = { ...fields, [field]: true };
  const nextAttempts = { ...attempts, [field]: (attempts[field] || 0) + 1 };
  await pool.query(
    `UPDATE public.sessions
       SET asked_fields = $2::jsonb,
           asked_attempts = $3::jsonb,
           updated_at = NOW()
     WHERE id=$1`,
    [sessionId, nextFields, nextAttempts]
  );
}

async function wasAsked(sessionId, field) {
  const { fields, attempts } = await getAskedState(sessionId);
  return { asked: !!fields[field], attempts: attempts[field] || 0 };
}

/* ─────────────────────────────────────────────────────────────
 * КОМАНДЫ
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
      userLang
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
 * КАТЕГОРИАЛЬНЫЙ РОУТЕР (KB exact → KB category → LLM)
 * ────────────────────────────────────────────────────────────*/

async function routeByCategory({ category, sessionId, userLang, userTextEN, userMsgId }) {
  // 1) Точная база QnA (совпадение вопроса)
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

  // 2) Категорийная KB
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
    answer = await llmFallbackReply(sessionId, userTextEN, userLang);
    const detected = await detectLanguage(answer);
    if (detected && detected !== userLang) {
      answer = (await translateCached(answer, detected, userLang)).text;
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

/* ─────────────────────────────────────────────────────────────
 * SMART REPLY
 * ────────────────────────────────────────────────────────────*/

export async function smartReply(sessionKey, channel, userTextRaw, userLangHint = "ru", extra = {}) {
  const sessionId = await upsertSession(sessionKey, channel);

  // 0) Канонизация
  const { canonical: userTextEN, sourceLang: srcLang, original: origText } =
    await toEnglishCanonical(userTextRaw);

  // базовый язык диалога
  let convLang = chooseConvLang(srcLang);

  // если пользователь просит другой язык
  if (askSwitchLang(userTextRaw)) {
    const want = extractRequestedLang(userTextRaw);
    if (want) {
      // если RU/PL/CS/EN — просто переключаемся без предупреждений
      if (SUPPORTED.has(want)) {
        convLang = want;
      } else {
        // любой другой — переключаемся и честно говорим про переводчик
        convLang = want;
        const note =
          convLang === 'ru' ? 'Переключаюсь. Я буду использовать переводчик, чтобы сохранить точность.'
        : convLang === 'pl' ? 'Przełączam się. Użyję tłumacza, żeby zachować dokładność.'
        : convLang === 'cs' ? 'Přepínám se. Pro přesnost použiji překladač.'
        : 'Switching language. I will use a translator to keep it accurate.';
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

  // 1) Команды
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

  // 2) Имя/контакт + факты
  const nameInThisMsg = detectAnyName(userTextRaw);
  const phone = detectPhone(userTextRaw);
  if (nameInThisMsg || phone) await updateContact(sessionId, { name: nameInThisMsg, phone });
  await ensureName(sessionId, userTextRaw, extra?.tgMeta);

  const facts = {};
  if (/чех/i.test(userTextRaw)) facts.country_interest = 'CZ';
  if (/польш/i.test(userTextRaw)) facts.country_interest = 'PL';
  if (/литв/i.test(userTextRaw))  facts.country_interest = 'LT';
  if (/работа/i.test(userTextRaw)) facts.intent_main = 'work';
  if (/бизнес/i.test(userTextRaw)) facts.intent_main = 'business';
  const num = userTextRaw.match(/\b(\d{1,3})\s*(кандидат|люд)/i)?.[1];
  if (num) facts.candidates_planned = Number(num);
  if (Object.keys(facts).length) await upsertFacts(sessionId, facts);

  // 3) Логи сообщения + QnA-трекинг
  const userMsgId = await saveMessage(
    sessionId, "user", userTextEN,
    null, "en", convLang, origText, null
  );
  await saveUserQuestion(sessionId, userTextEN);

  // 4) Имя — спросим максимум 2 раза
  const session = await getSession(sessionId);
  const knownName = nameInThisMsg || session?.user_name?.trim();
  if (!knownName) {
    const { asked, attempts } = await wasAsked(sessionId, 'user_name');
    if (!asked || attempts < 2) {
      const ask = (attempts === 0)
        ? buildAskName(convLang, userTextRaw)
        : buildAskName(convLang, userTextRaw).replace('Подскажите, пожалуйста,', 'Напомню, пожалуйста,');
      const { canonical } = await toEnglishCanonical(ask);
      await saveMessage(
        sessionId, "assistant", canonical,
        { category: "ask_name", strategy: attempts === 0 ? "precheck_name" : "precheck_name_repeat" },
        "en", convLang, ask, "ask_name"
      );
      await setAsked(sessionId, 'user_name');
      return ask;
    }
    const skip = convLang === 'ru'
      ? 'Если не хотите называть имя — не проблема. Давайте продолжим по делу.'
      : "If you prefer not to share your name, no problem. Let's continue.";
    const { canonical } = await toEnglishCanonical(skip);
    await saveMessage(
      sessionId, "assistant", canonical,
      { category: "ask_name", strategy: "precheck_name_skip" },
      "en", convLang, skip, "ask_name"
    );
    return skip;
  }

  // 5) Обновим стиль и возьмём психотип
  await maybeUpdateStyle(sessionId);
  const profile = await getSessionProfile(sessionId);
  const persona = profile?.psychotype || 'default';

  // 6) Оффтоп: авто и пр. — короткий ответ + возврат к делу
  if (/машин|автомобил|cars?/i.test(userTextRaw)) {
    const short = (convLang === 'ru')
      ? 'Коротко: по машинам могу подсказать, но наш фокус — легальное трудоустройство. Вернёмся к кандидатам? Какая страна и ставка?'
      : 'Brief: I can comment on cars, but our focus is legal job placement. Back to candidates? Which country and salary?';
    const { canonical } = await toEnglishCanonical(short);
    await saveMessage(sessionId, 'assistant', canonical,
      { category: 'offtopic', strategy: 'brief_then_return' },
      'en', convLang, short, 'offtopic');
    return short;
  }

  // 7) Если критичных фактов нет — спросим ОДИН раз в стиле персоны
  const need = [];
  if (!profile?.country_interest) need.push('country');
  if (!profile?.intent_main)      need.push('position');
  if (!profile?.candidates_planned) need.push('candidates');

  if (need.length) {
    let needAsk = false;
    for (const f of need) {
      const { asked, attempts } = await wasAsked(sessionId, f);
      if (!asked || attempts < 1) { needAsk = true; break; }
    }
    if (needAsk) {
      const short = need.length === 1 ? `Нужна: ${need[0]}` : `Нужно: ${need.join(', ')}`;
      const cta = (convLang === 'ru')
        ? 'Пришлите, пожалуйста, и я продолжу.'
        : 'Please send, and I will continue.';
      const text = personaReply(persona, short, cta);
      const { canonical } = await toEnglishCanonical(text);
      await saveMessage(sessionId, 'assistant', canonical,
        { category: 'collect_facts', strategy: `ask_${persona}`, fields: need },
        'en', convLang, text, 'collect_facts');
      for (const f of need) await setAsked(sessionId, f);
      return text;
    }
  }

  // 8) Классификация → маршрутизация
  const category = await classifyCategory(userTextRaw);

  switch (category) {
    case 'greeting':
    case 'smalltalk':
    case 'general':
    case 'visa':
    case 'work':
    case 'business':
    case 'docs':
    case 'price':
    case 'timeline':
    case 'process':
    case 'expensive':
    default:
      return await routeByCategory({ category, sessionId, userLang: convLang, userTextEN, userMsgId });
  }
}