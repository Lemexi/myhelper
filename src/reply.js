// /src/reply.js
import { SYSTEM_PROMPT } from './prompt.js';
import {
  upsertSession, updateContact, saveMessage, loadRecentMessages,
  loadLatestSummary, logReply
} from './db.js';
import { kbFind } from './kb.js';
import { translateCached } from './translator.js';
import { classifyCategory, detectName, detectPhone } from './classifier.js';
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

export async function smartReply(sessionKey, channel, userText, userLang='ru') {
  const sessionId = await upsertSession(sessionKey, channel);

  // Контакты (если прислали)
  const name = detectName(userText);
  const phone = detectPhone(userText);
  if (name || phone) await updateContact(sessionId, { name, phone });

  // Вход
  const userMsgId = await saveMessage(sessionId, 'user', userText, null, userLang, null, null, null);

  // Категория
  const category = await classifyCategory(userText);

  // 1) KB на нужном языке
  let kb = await kbFind(category, userLang);
  let answer, strategy = 'fallback_llm', kbItemId = null;

  if (kb) {
    answer = kb.answer;
    strategy = 'kb_hit';
    kbItemId = kb.id;
  } else {
    // 2) KB RU + перевод
    const kbRu = await kbFind(category, 'ru');
    if (kbRu) {
      const { text: translated } = await translateCached(kbRu.answer, 'ru', userLang);
      answer = translated;
      strategy = 'kb_translated';
      kbItemId = kbRu.id;
    }
  }

  // 3) Fallback: LLM
  if (!answer) {
    answer = await replyCore(sessionId, userText);
  }

  await logReply(sessionId, strategy, category, kbItemId, userMsgId, null);
  await saveMessage(sessionId, 'assistant', answer, { category, strategy }, userLang, null, null, category);

  return answer;
}
