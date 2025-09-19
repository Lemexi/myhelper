// /src/playbook.js
// Dialogue stages as a lightweight state machine.
// Copy is EN-only. reply.js/translator.js handle the user-facing language.

import { pool } from "./db.js";
import { getSessionProfile } from "./memory.js";

// Языки, на которых говорим напрямую (без предупреждений)
export const DIRECT_LANGS = new Set(["en", "ru", "pl", "cz"]);

/* ───────────────── asked/anti-repeat helpers ───────────────── */

async function getAskedState(sessionId){
  const { rows } = await pool.query(
    "SELECT asked_fields, asked_attempts FROM public.sessions WHERE id=$1",
    [sessionId]
  );
  const s = rows[0] || {};
  return { fields: s.asked_fields || {}, attempts: s.asked_attempts || {} };
}
async function markAsked(sessionId, keys){
  const { fields, attempts } = await getAskedState(sessionId);
  const nextFields = { ...fields };
  const nextAttempts = { ...attempts };
  for (const k of keys){
    nextFields[k] = true;
    nextAttempts[k] = (nextAttempts[k] || 0) + 1;
  }
  await pool.query(
    `UPDATE public.sessions
       SET asked_fields=$2::jsonb, asked_attempts=$3::jsonb, updated_at=NOW()
     WHERE id=$1`,
    [sessionId, nextFields, nextAttempts]
  );
}
async function wasAsked(sessionId, key){
  const { fields, attempts } = await getAskedState(sessionId);
  return { asked: !!fields[key], attempts: attempts[key] || 0 };
}

/* ───────────────── stage helpers ───────────────── */

export async function getStage(sessionId){
  const { rows } = await pool.query("SELECT stage FROM public.sessions WHERE id=$1", [sessionId]);
  return rows[0]?.stage || "intro";
}
export async function setStage(sessionId, stage){
  await pool.query("UPDATE public.sessions SET stage=$2, updated_at=NOW() WHERE id=$1", [sessionId, stage]);
}

// CTA в зависимости от психотипа
function personaCTA(persona, short, cta){
  const T = {
    commander: (a,c)=>`${a?a+"\n":""}Plan: ${c||"country, role, rate — and we move."}`,
    diplomat:  (a,c)=>`${a?a+"\n":""}Precisely: ${c||"please specify country/role/rate."}`,
    humanist:  (a,c)=>`${a?"I hear you. "+a+"\n":""}I’ll keep it gentle — ${c||"share the details and we continue."}`,
    star:      (a,c)=>`${a?a+"\n":""}Short: ${c||"country + rate — let’s go."}`,
    default:   (a,c)=>`${a?a+"\n":""}${c||"Please share country, role and rate."}`
  };
  return (T[persona] || T.default)(short, cta);
}

/* ───────────────── text builders (EN) ───────────────── */

// приветствие — всегда начинается сценарием, потом уже KB/LLM
function greetText(name){
  // Если имя есть — используем. Иначе просто Hi!
  return `Hi${name?`, ${name}`:""}! I'm Viktor from RenovoGo. We help with **legal EU job placement** and **business setup**. How can I help right now?`;
}

// уточняем, КТО и ЗА ЧЕМ пришёл
function whoAndGoalAsk(){
  return `Quick check so I guide you right:
- Are you an **agency / recruiter** or an **individual** looking for a job?
- What's your current goal: **job** or **business setup**?
Reply in 1–2 lines and I’ll tailor next steps.`;
}

// сбор базовых фактов (общие)
function discoveryAsk(persona, missing){
  const short = (missing.length === 1) ? `Need: ${missing[0]}` : `Need: ${missing.join(", ")}`;
  const cta   = "Please send and I will continue.";
  return personaCTA(persona, short, cta);
}

// уточнения для АГЕНТСТВА
function agencyProbeAsk(){
  return `For agencies: a few details to calibrate:
- Office country (where you operate)?
- How long on the market?
- Avg candidates you process per month?
This helps me propose a realistic pilot.`;
}

// мини-демо — общая подача процесса
function demoTextGeneric(){
  return `How we work:
1) Verify the case and documents (legal first).
2) Agree on the contract type, timelines, responsibilities.
3) Start with a **pilot (1 candidate)** — fast, transparent, measurable.
If that fits, I'll outline next steps and a draft contract.`;
}

// мини-демо — если цель BUSINESS
function demoTextBusiness(){
  return `For **business setup**:
- We advise on the legal route (CZ/PL), permits, timelines.
- We structure responsibilities and a clear SLA.
- We start with a scoped paid advisory and a step-by-step plan.
Share your desired country and scope, and I’ll outline the track.`;
}

// мини-демо — если INDIVIDUAL (job seeker)
function demoTextIndividual(){
  return `For **individual job placement**:
- We focus on legal employment (permits, contract, embassy slots where possible).
- We clarify profession, expected net salary, and timelines.
- We begin with one concrete offer and a transparent process.`;
}

// запрос «док-специфики» после демо
function specificsAsk(){
  return `Please share what you have: website/card (if any), sample role/contract, expected rate and timelines — I’ll propose a pilot or next legal steps.`;
}

/* ───────────────── main stage engine ───────────────── */

// ВАЖНО: profile берём из memory.js (там же upsertFacts из reply.js).
// Ожидаемые поля профиля: user_name, intent_main ('work'|'business'),
// actor_type ('agency'|'individual'), country_interest, candidates_planned, etc.
export async function handleByStage({ sessionId, profile, persona }) {
  let stage = await getStage(sessionId);
  const name  = (profile?.user_name || "").trim();
  const intent = profile?.intent_main || null;          // work | business
  const actor  = profile?.actor_type || null;           // agency | individual

  /* ─── INTRO ─── */
  if (stage === "intro"){
    const greeted = await wasAsked(sessionId, "intro_greeted");
    if (!greeted.asked){
      await markAsked(sessionId, ["intro_greeted"]);
      return { textEN: greetText(name || null), stage, strategy: "intro:greet" };
    }

    // имя спросим максимум 2 раза (если его нет)
    if (!name){
      const asked = await wasAsked(sessionId, "user_name");
      if (asked.attempts < 2){
        await markAsked(sessionId, ["user_name"]);
        return { textEN: "How should I address you?", stage, strategy: "intro:ask_name" };
      }
    }

    // переходим к выяснению роли/цели
    await setStage(sessionId, "role_goal");
    stage = "role_goal";
  }

  /* ─── ROLE_GOAL: кто и какая цель ─── */
  if (stage === "role_goal"){
    // Если чего-то не хватает — спросим один раз
    if (!actor || !intent){
      const asked = await wasAsked(sessionId, "role_goal_ask");
      if (asked.attempts < 1){
        await markAsked(sessionId, ["role_goal_ask"]);
        return { textEN: whoAndGoalAsk(), stage, strategy: "role_goal:ask" };
      }
    }

    // Если агентство — пойдём через agency_discovery,
    // если индивидуал — сразу к discovery (общий), затем к demo_individual
    if (actor === "agency"){
      await setStage(sessionId, "agency_discovery");
      stage = "agency_discovery";
    } else {
      await setStage(sessionId, "discovery");
      stage = "discovery";
    }
  }

  /* ─── AGENCY_DISCOVERY: офис, стаж, объёмы ─── */
  if (stage === "agency_discovery"){
    const miss = [];
    if (!profile?.country_interest)   miss.push("country");
    if (!profile?.candidates_planned) miss.push("candidates");
    // доп. поля для агентств (сохраняются в facts через reply.js, когда ты их начнёшь писать парсером):
    if (!profile?.agency_office_country) miss.push("office_country");
    if (!profile?.agency_years_on_market) miss.push("years_on_market");

    if (miss.length){
      // спросим «пакетом» один раз нормальным вопросом для агентств
      const asked = await wasAsked(sessionId, "agency_probe");
      if (asked.attempts < 1){
        await markAsked(sessionId, ["agency_probe"]);
        return { textEN: agencyProbeAsk(), stage, strategy: "agency:probe" };
      }
      // если уже спрашивали — напомним кратко через persona CTA
      return { textEN: discoveryAsk(persona, miss), stage, strategy: "agency:remind_missing" };
    }

    // всё собрали → мини-демо под агентство (generic достаточно)
    const demoShown = await wasAsked(sessionId, "agency_demo_shown");
    if (!demoShown.asked){
      await markAsked(sessionId, ["agency_demo_shown"]);
      return { textEN: demoTextGeneric(), stage, strategy: "agency:demo" };
    }

    await setStage(sessionId, "specifics");
    stage = "specifics";
  }

  /* ─── DISCOVERY (индивидуал / общий) ─── */
  if (stage === "discovery"){
    const miss = [];
    if (!profile?.country_interest)   miss.push("country");
    if (!profile?.intent_main)        miss.push("role");
    if (!profile?.candidates_planned && profile?.actor_type === "agency") {
      // для индивидуала кандидаты не обязательны
      miss.push("candidates");
    }

    if (miss.length){
      const askKeys = [];
      for (const k of miss){
        const was = await wasAsked(sessionId, `ask_${k}`);
        if (was.attempts < 1) askKeys.push(k);
      }
      if (askKeys.length){
        await markAsked(sessionId, askKeys.map(k=>`ask_${k}`));
        return { textEN: discoveryAsk(persona, askKeys), stage, strategy: "discovery:ask" };
      }
      return { textEN: discoveryAsk(persona, miss), stage, strategy: "discovery:remind" };
    }

    // мини-демо: ветвим по intent
    const demoFlag = (intent === "business")
      ? "demo_business_shown"
      : (profile?.actor_type === "individual" ? "demo_individual_shown" : "demo_shown");

    const already = await wasAsked(sessionId, demoFlag);
    if (!already.asked){
      await markAsked(sessionId, [demoFlag]);
      const textEN = (intent === "business")
        ? demoTextBusiness()
        : (profile?.actor_type === "individual" ? demoTextIndividual() : demoTextGeneric());
      return { textEN, stage, strategy: "discovery:demo" };
    }

    await setStage(sessionId, "specifics");
    stage = "specifics";
  }

  /* ─── SPECIFICS: просим подтверждающие документы/детали ─── */
  if (stage === "specifics"){
    const asked = await wasAsked(sessionId, "specifics_ask");
    if (!asked.asked){
      await markAsked(sessionId, ["specifics_ask"]);
      return {
        textEN: specificsAsk(),
        stage, strategy: "specifics:ask_docs"
      };
    }
    // дальше можно будет добавить OFFER → OBJECTIONS → CLOSE
  }

  return null; // пусть общий роутер решает (KB/QnA/LLM)
}