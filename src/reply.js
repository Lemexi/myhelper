// /src/reply.js
import { SYSTEM_PROMPT } from './prompt.js';
import {
  upsertSession, updateContact, saveMessage, loadRecentMessages,
  loadLatestSummary, logReply, getLastAuditCategory
} from './db.js';
import { kbFind, kbInsertAnswer } from './kb.js';
import { translateCached, translateWithStyle, resolveTargetLangCode } from './translator.js';
import {
  classifyCategory, detectName, detectPhone,
  isCmdTeach, parseCmdTeach,
  isCmdTranslate, parseCmdTranslate,
  isCmdAnswerExpensive
} from './classifier.js';
import { runLLM } from './llm.js';

async function replyCore(sessionId, userText) {
  const recent = await loadRecentMessages(sessionId, 24);
  const summary = await loadLatestSummary(sessionId);

  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  if (summary) messages.push({ role: 'system', content: `Краткая сводка прошлой истории:\n${summary}` });
  messages.push(...recent);
  messages.push({ role: 'user', content: userText });

  const { text } = await runLLM(messages);
  return text;
}

async function handleCmdTranslate(sessionId, rawText, userLang = 'ru') {
  const { targetLangWord, text } = parseCmdTranslate(rawText);
  const target = resolveTargetLangCode(targetLangWord) || 'en';
  if (!text) {
    const msg = 'Нужен текст после команды «Переведи».';
    await saveMessage(sessionId, 'assistant', msg, { category: 'translate', strategy: 'cmd_translate_error' }, userLang, null, null, 'translate');
    return msg;
  }

  const { styled, styledRu, targetLang } = await translateWithStyle({ sourceText: text, targetLang });
  const combined = `🔁 Перевод (${targetLang.toUpperCase()}):\n${styled}\n\n💬 Для тебя (RU):\n${styledRu}`;
  await saveMessage(sessionId, 'assistant', combined, { category: 'translate', strategy: 'cmd_translate' }, userLang, null, null, 'translate');
  return combined;
}

async function handleCmdTeach(sessionId, rawText, userLang = 'ru') {
  const taught = parseCmdTeach(rawText);
  if (!taught) {
    const msg = 'Нужен текст после «Ответил бы:».';
    await saveMessage(sessionId, 'assistant', msg, { category: 'teach', strategy: 'cmd_teach_error' }, userLang, null, null, 'teach');
    return msg;
  }
  // Берём последнюю категорию диалога; если нет — пишем в 'general'
  const lastCat = (await getLastAuditCategory(sessionId)) || 'general';
  const kbId = await kbInsertAnswer(lastCat, userLang || 'ru', taught, true);

  // Сообщаем и сразу отвечаем «как надо»
  const ack = '✅ В базу добавлено.';
  const out = `${ack}\n\n${taught}`;
  await saveMessage(sessionId, 'assistant', out, { category: lastCat, strategy: 'cmd_teach', kb_id: kbId }, userLang, null, null, lastCat);
  return out;
}

async function handleCmdAnswerExpensive(sessionId, userLang = 'ru') {
  // Прямой вызов категории 'expensive'
  const kb = await kbFind('expensive', userLang) || await kbFind('expensive', 'ru');
  let answer;
  if (kb?.answer) {
    if (userLang !== 'ru' && kb && kb.answer && userLang !== 'ru') {
      const { text: translated } = await translateCached(kb.answer, 'ru', userLang);
      answer = translated;
    } else {
      answer = kb.answer;
    }
  } else {
    // Fallback через LLM, если KB пуст
    answer = await replyCore(sessionId, 'Клиент говорит: дорого. Дай краткий ответ Виктора (WhatsApp-стиль) с мягкой работой с ценой и CTA.');
  }
  await saveMessage(sessionId, 'assistant', answer, { category: 'expensive', strategy: 'cmd_answer_expensive' }, userLang, null, null, 'expensive');
  await logReply(sessionId, 'cmd', 'expensive', kb?.id || null, null, 'trigger: answer expensive');
  return answer;
}

export async function smartReply(sessionKey, channel, userText, userLang='ru') {
  const sessionId = await upsertSession(sessionKey, channel);

  // Контакты (если прислали)
  const name = detectName(userText);
  const phone = detectPhone(userText);
  if (name || phone) await updateContact(sessionId, { name, phone });

  // Вход
  const userMsgId = await saveMessage(sessionId, 'user', userText, null, userLang, null, null, null);

  // 0) Команды-триггеры (высший приоритет)
  if (isCmdTranslate(userText)) {
    const out = await handleCmdTranslate(sessionId, userText, userLang);
    await logReply(sessionId, 'cmd', 'translate', null, userMsgId, 'trigger: translate');
    return out;
  }
  if (isCmdTeach(userText)) {
    const out = await handleCmdTeach(sessionId, userText, userLang);
    await logReply(sessionId, 'cmd', 'teach', null, userMsgId, 'trigger: teach');
    return out;
  }
  if (isCmdAnswerExpensive(userText)) {
    const out = await handleCmdAnswerExpensive(sessionId, userLang);
    await logReply(sessionId, 'cmd', 'expensive', null, userMsgId, 'trigger: answer expensive');
    return out;
  }

  // 1) Классификация
  const category = await classifyCategory(userText);

  // 2) KB на нужном языке
  let kb = await kbFind(category, userLang);
  let answer, strategy = 'fallback_llm', kbItemId = null;

  if (kb) {
    answer = kb.answer;
    strategy = 'kb_hit';
    kbItemId = kb.id;
  } else {
    // 3) KB RU + перевод
    const kbRu = await kbFind(category, 'ru');
    if (kbRu) {
      const { text: translated } = await translateCached(kbRu.answer, 'ru', userLang);
      answer = translated;
      strategy = 'kb_translated';
      kbItemId = kbRu.id;
    }
  }

  // 4) Fallback: LLM
  if (!answer) {
    answer = await replyCore(sessionId, userText);
  }

  await logReply(sessionId, strategy, category, kbItemId, userMsgId, null);
  await saveMessage(sessionId, 'assistant', answer, { category, strategy }, userLang, null, null, category);

  return answer;
}
