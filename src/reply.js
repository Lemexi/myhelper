// /src/reply.js
import { SYSTEM_PROMPT } from "./prompt.js";
import {
  upsertSession, updateContact, saveMessage, loadRecentMessages, loadLatestSummary,
  logReply, getLastAuditCategory, getSession, getLastUserBotPair,
  insertCorrection, findCorrectionsByCategory
} from "./db.js";
import { kbFind } from "./kb.js";
import { translateCached, translateWithStyle, toEnglishCanonical, detectLanguage } from "./translator.js";
import {
  classifyCategory, detectAnyName, detectPhone, isCmdTeach, parseCmdTeach, isCmdTranslate, parseCmdTranslate,
  isCmdAnswerExpensive, extractGreeting, stripQuoted, isSlashTeach, isSlashTranslate, isSlashExpensive
} from "./classifier.js";
import { runLLM } from "./llm.js";

/* helpers */
function looksLikeShortAck(s=""){ const t=(s||"").trim(); if(t.length<=2) return true; if(t.length<=30 && !t.includes("?")) return true; return false; }
function similar(a="",b=""){ const A=(a||"").trim().toLowerCase(); const B=(b||"").trim().toLowerCase(); if(!A||!B) return false; if(A===B) return true; const s=A.length<B.length?A:B; const l=A.length<B.length?B:A; return l.includes(s) && s.length>=Math.min(60,l.length*0.8); }
function buildAskName(userLang, raw){ const hi=extractGreeting(raw); const by={
  ru:`${hi?hi+". ":""}Подскажите, пожалуйста, как вас зовут, чтобы я знал, как к вам обращаться?`,
  uk:`${hi?hi+". ":""}Підкажіть, будь ласка, як вас звати, щоб я знав, як до вас звертатись?`,
  pl:`${hi?hi+". ":""}Proszę podać imię, żebym wiedział jak się zwracać.`,
  cz:`${hi?hi+". ":""}Prosím, jak se jmenujete, ať vím, jak vás oslovovat?`,
  en:`${hi?hi+". ":""}May I have your name so I know how to address you?`
}; return by[userLang]||by.en; }

/* LLM fallback */
async function replyCore(sessionId, userTextEN){
  const recent=await loadRecentMessages(sessionId,24);
  const summary=await loadLatestSummary(sessionId);
  const messages=[{role:"system",content:SYSTEM_PROMPT}];
  if(summary) messages.push({role:"system",content:`Краткая сводка прошлой истории:\n${summary}`});
  messages.push(...recent);
  messages.push({role:"user",content:userTextEN});
  const { text }=await runLLM(messages);
  return text;
}

/* команды */
async function handleCmdTranslate(sessionId, raw, userLang="ru"){
  const { targetLangWord, text } = parseCmdTranslate(raw);
  const targetLang=(targetLangWord||"en").toLowerCase();
  if(!text||text.length<2){
    const msg="Нужен текст после команды «Переведи» / /translate.";
    const { canonical }=await toEnglishCanonical(msg);
    await saveMessage(sessionId,"assistant",canonical,{category:"translate",strategy:"cmd"},"en",userLang,msg,"translate");
    return [msg];
  }
  const { targetLang:tgt, styled, styledRu, altStyled, altStyledRu }=await translateWithStyle({sourceText:text,targetLang});
  const parts=[styled, styledRu]; if(altStyled){ parts.push(altStyled); if(altStyledRu) parts.push(altStyledRu); }
  const combined=parts.join("\n\n");
  const { canonical }=await toEnglishCanonical(combined);
  await saveMessage(sessionId,"assistant",canonical,{category:"translate",strategy:"cmd",target:tgt,pieces:parts.length},"en",userLang,combined,"translate");
  return parts;
}

// /teach и «Ответил бы…»: правим ПОСЛЕДНИЙ ответ бота, сохраняя ещё и триггер пользователя
async function handleCmdTeach(sessionId, raw, userLang="ru"){
  const taughtLocal=parseCmdTeach(raw);
  if(!taughtLocal){
    const msg="Нужен текст после «Ответил бы…» / /teach.";
    const { canonical }=await toEnglishCanonical(msg);
    await saveMessage(sessionId,"assistant",canonical,{category:"teach",strategy:"cmd"},"en",userLang,msg,"teach");
    return [msg];
  }
  const pair=await getLastUserBotPair(sessionId);
  if(!pair){
    const msg="Нет моего предыдущего ответа в этой сессии. Напиши вопрос — я отвечу, затем сможешь меня поправить.";
    const { canonical }=await toEnglishCanonical(msg);
    await saveMessage(sessionId,"assistant",canonical,{category:"teach",strategy:"cmd"},"en",userLang,msg,"teach");
    return [msg];
  }
  const prev_cat = pair.bot_cat || (await getLastAuditCategory(sessionId)) || "general";
  const { canonical: taught_en }=await toEnglishCanonical(taughtLocal);
  // сохраняем правку с триггером (предыдущее сообщение пользователя)
  const corrId=await insertCorrection({
    session_id: sessionId,
    bot_message_id: pair.bot_id,
    category: prev_cat,
    trigger_user_en: pair.user_en || "",
    prev_answer_en: pair.bot_en || "",
    taught_en, taught_local: taughtLocal, taught_lang: userLang
  });
  // сохраняем только чек в content
  const ok="✅ В базу добавлено.";
  const { canonical: okEN }=await toEnglishCanonical(ok);
  await saveMessage(sessionId,"assistant",okEN,
    {category:prev_cat,strategy:"cmd_teach",corr_id:corrId,prev_bot_msg_id:pair.bot_id,taught_text:taughtLocal,taught_en},
    "en",userLang,`${ok}\n\n${taughtLocal}`,prev_cat
  );
  // выдаём чек и сам текст отдельными пузырями
  return [ok, taughtLocal];
}

async function handleCmdAnswerExpensive(sessionId,userLang="ru"){
  const kb=(await kbFind("expensive",userLang))||(await kbFind("expensive","ru"));
  let answer;
  if(kb?.answer){ answer = userLang!=="ru" ? (await translateCached(kb.answer,"ru",userLang)).text : kb.answer; }
  else { answer = await replyCore(sessionId, "Client says it's expensive. Short, firm, value-first, with CTA."); }
  const { canonical }=await toEnglishCanonical(answer);
  await saveMessage(sessionId,"assistant",canonical,{category:"expensive",strategy:"cmd"},"en",userLang,answer,"expensive");
  await logReply(sessionId,"cmd","expensive",kb?.id||null,null,"trigger: answer expensive");
  return [answer];
}

/* применение правок: нужно сходство и по триггеру пользователя, и по старому ответу */
async function applyCorrectionsIfAny({ category, draftAnswer, userLang, userTextEN }){
  const { canonical: draftEN }=await toEnglishCanonical(draftAnswer);
  const rows=await findCorrectionsByCategory(category,30);
  for(const c of rows){
    const triggerOk = c.trigger_user_en ? similar(userTextEN, c.trigger_user_en) : false;
    const answerOk  = similar(draftEN, c.prev_answer_en);
    if(triggerOk && answerOk){
      // подстановка обученного текста
      if(c.taught_lang && c.taught_local){
        if(c.taught_lang===userLang) return c.taught_local;
        const { text }=await translateCached(c.taught_en,"en",userLang);
        return text;
      }
      const { text }=await translateCached(c.taught_en,"en",userLang);
      return text;
    }
  }
  return draftAnswer;
}

/* основной роутер */
export async function smartReply(sessionKey, channel, userTextRaw, userLangHint="ru"){
  const sessionId=await upsertSession(sessionKey, channel);
  const { canonical: userTextEN, sourceLang: srcLang, original: origText }=await toEnglishCanonical(userTextRaw);
  const userLang=srcLang||userLangHint;
  const cleaned=stripQuoted(userTextRaw);

  // слэши
  if(isSlashTeach(cleaned)) return await handleCmdTeach(sessionId, `Ответил бы ${cleaned.replace(/^\/teach\b\s*/i,"")}`, userLang);
  if(isSlashTranslate(cleaned)) return await handleCmdTranslate(sessionId, cleaned.replace(/^\/translate\b\s*/i,"переведи "), userLang);
  if(isSlashExpensive(cleaned)) return await handleCmdAnswerExpensive(sessionId, userLang);

  // естественные команды
  if(isCmdTeach(cleaned)){
    const msgId=await saveMessage(sessionId,"user",userTextEN,{kind:"cmd_detected",cmd:"teach"},"en",userLang,origText,null);
    const out=await handleCmdTeach(sessionId, cleaned, userLang);
    await logReply(sessionId,"cmd","teach",null,msgId,"trigger: teach(last_bot)");
    return out;
  }
  if(isCmdTranslate(cleaned)){
    const { text:t }=parseCmdTranslate(cleaned);
    if(t&&t.length>=2){
      const msgId=await saveMessage(sessionId,"user",userTextEN,{kind:"cmd_detected",cmd:"translate"},"en",userLang,origText,null);
      const out=await handleCmdTranslate(sessionId, cleaned, userLang);
      await logReply(sessionId,"cmd","translate",null,msgId,"trigger: translate");
      return out;
    }
  }
  if(isCmdAnswerExpensive(cleaned)){
    const msgId=await saveMessage(sessionId,"user",userTextEN,{kind:"cmd_detected",cmd:"answer_expensive"},"en",userLang,origText,null);
    const out=await handleCmdAnswerExpensive(sessionId, userLang);
    await logReply(sessionId,"cmd","expensive",null,msgId,"trigger: answer expensive");
    return out;
  }

  // имя/телефон
  const name=detectAnyName(userTextRaw);
  const phone=detectPhone(userTextRaw);
  if(name||phone) await updateContact(sessionId,{name,phone});

  // сохраняем вход
  const userMsgId=await saveMessage(sessionId,"user",userTextEN,null,"en",userLang,origText,null);

  // если имени нет — спросим
  const session=await getSession(sessionId);
  const knownName=name||session?.user_name?.trim();
  if(!knownName){
    const ask=buildAskName(userLang,userTextRaw);
    const { canonical }=await toEnglishCanonical(ask);
    await saveMessage(sessionId,"assistant",canonical,{category:"ask_name",strategy:"cmd"},"en",userLang,ask,"ask_name");
    return [ask];
  }

  // KB → перевод → LLM
  const category=await classifyCategory(userTextRaw);
  let kb=await kbFind(category, userLang);
  let answer, strategy="fallback_llm", kbItemId=null;
  if(kb){ answer=kb.answer; strategy="kb_hit"; kbItemId=kb.id; }
  else{
    const kbRu=await kbFind(category,"ru");
    if(kbRu){ answer=(await translateCached(kbRu.answer,"ru",userLang)).text; strategy="kb_translated"; kbItemId=kbRu.id; }
  }
  if(!answer){
    answer=await replyCore(sessionId, userTextEN);
    const lang=await detectLanguage(answer);
    if(lang!==userLang) answer=(await translateCached(answer,lang,userLang)).text;
  }

  // Применяем правки: одновременно совпадает триггер (пользователь сейчас) и старый ответ
  if(!looksLikeShortAck(userTextRaw)){
    answer=await applyCorrectionsIfAny({ category, draftAnswer:answer, userLang, userTextEN });
  }

  // исход
  const { canonical: ansEN }=await toEnglishCanonical(answer);
  await logReply(sessionId, strategy, category, kbItemId, userMsgId, null);
  await saveMessage(sessionId,"assistant",ansEN,{category, strategy},"en",userLang,answer,category);
  return [answer];
}