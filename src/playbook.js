// /src/playbook.js
// Dialogue stages engine (intro → discovery → demo → specifics).
// Copy is EN-only; reply.js will translate if needed.

import { pool } from "./db.js";
import { getSessionProfile, upsertFacts } from "./memory.js";

// Direct languages we can speak without disclaimer.
// Other languages → we talk EN by default (or switch with translator notice in reply.js).
export const DIRECT_LANGS = new Set(["en", "ru", "pl", "cz"]);

/* ---------------- asked flags (anti-repeat) ---------------- */
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
  const nf = { ...fields }, na = { ...attempts };
  for (const k of keys){ nf[k] = true; na[k] = (na[k] || 0) + 1; }
  await pool.query(
    `UPDATE public.sessions
       SET asked_fields=$2::jsonb, asked_attempts=$3::jsonb, updated_at=NOW()
     WHERE id=$1`,
    [sessionId, nf, na]
  );
}
async function wasAsked(sessionId, key){
  const { fields, attempts } = await getAskedState(sessionId);
  return { asked: !!fields[key], attempts: attempts[key] || 0 };
}

/* ---------------- persona CTA sugar ------------------------ */
// RU-стили оставили короткими; текст сам по себе EN ниже.
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

/* ---------------- stage texts (no **bold**) ---------------- */
function greetText(name){
  return `Hi${name?`, ${name}`:""}! I'm Viktor from RenovoGo. We help with legal EU job placement and business setup.`;
}
function quickCheckText(){
  return `Quick check so I guide you right:
- Are you an agency/recruiter or a private person looking for a job?
- What is your current goal: work or business setup?
Reply in 1–2 lines and I’ll route next steps.`;
}
function discoveryAsk(persona, missing){
  const short = (missing.length === 1)
    ? `Need: ${missing[0]}`
    : `Need: ${missing.join(", ")}`;
  const cta = "Please send and I will continue.";
  return personaCTA(persona, short, cta);
}
function demoTextAgency(){
  return (
`How we work with agencies:
1) We verify your case and documents.
2) We agree on contract type, timelines and responsibilities.
3) We start with a pilot (1 candidate) — fast and transparent.
We work legally in Poland and Czechia: full package from work authorization to embassy booking where possible.`
  );
}
function demoTextCandidate(){
  return (
`How I help candidates:
1) I assess your profile and legal options.
2) We choose a country, role and realistic salary/timelines.
3) We proceed step-by-step with legal paperwork and job placement.`
  );
}
function specificsAsk(){
  return "Please share what you have: website/business card, sample role/contract, expected rate and timelines — I’ll propose a pilot.";
}

/* ---------------- light intent extraction ------------------ */
// Very small heuristics to set facts before stage logic.
export function inferQuickFacts(text){
  const t = (text || "").toLowerCase();

  const facts = {};
  if (/\b(b2b|agency|recruit(er|ing)|агентств|рекрутер|подбор|кадров)\b/i.test(text)) {
    facts.lead_type = "agency";
    facts.intent_main = "business";
  }
  if (/\bprivate person|я ищу работу|ищу работу|candidate\b/i.test(text)) {
    facts.lead_type = "candidate";
    facts.intent_main = facts.intent_main || "work";
  }

  if (/qatar|катар/i.test(text)) facts.country_origin = "QA";
  if (/poland|польш|polska|pl\b/i.test(text)) facts.country_interest = "PL";
  if (/czech|чех|czechia|cz\b/i.test(text)) facts.country_interest = "CZ";

  // role keywords
  if (/welder|свар|driver|водител|cook|повар|builder|строит/i.test(text))
    facts.intent_main = "work";

  // rough candidates quantity
  const n = text.match(/\b(\d{1,3})\s*(people|кандидат|люд)/i)?.[1];
  if (n) facts.candidates_planned = Number(n);

  return facts;
}

/* ---------------- main stage engine ------------------------ */
export async function handleByStage({ sessionId, persona }) {
  let stage = "intro";
  const profile = await getSessionProfile(sessionId);
  const name  = (profile?.user_name || "").trim();

  // figure current stage from db
  const { rows } = await pool.query("SELECT stage FROM public.sessions WHERE id=$1", [sessionId]);
  if (rows[0]?.stage) stage = rows[0].stage;

  /* INTRO — greet once; if user already told plan, skip “how can I help” */
  if (stage === "intro"){
    const greeted = await wasAsked(sessionId, "intro_greeted");
    if (!greeted.asked){
      await markAsked(sessionId, ["intro_greeted"]);
      // greet, then immediately do a quick check instead of “How can I help?”
      return {
        textEN: `${greetText(name || null)}\n${quickCheckText()}`,
        stage,
        strategy: "intro:greet+check"
      };
    }
    if (!name){
      const asked = await wasAsked(sessionId, "user_name");
      if (asked.attempts < 2){
        await markAsked(sessionId, ["user_name"]);
        return { textEN: "How should I address you?", stage, strategy: "intro:ask_name" };
      }
    }
    // jump to discovery
    await pool.query("UPDATE public.sessions SET stage='discovery', updated_at=NOW() WHERE id=$1", [sessionId]);
    stage = "discovery";
  }

  /* DISCOVERY — collect essentials; then show demo tailored by lead_type */
  if (stage === "discovery"){
    const miss = [];
    if (!profile?.country_interest)   miss.push("country");
    if (!profile?.intent_main)        miss.push("role");
    if (!profile?.candidates_planned && profile?.lead_type === "agency") miss.push("candidates");

    if (miss.length){
      // ask each missing at most once
      const askKeys = [];
      for (const k of miss){
        const was = await wasAsked(sessionId, `ask_${k}`);
        if (was.attempts < 1) askKeys.push(k);
      }
      if (askKeys.length){
        await markAsked(sessionId, askKeys.map(k => `ask_${k}`));
        return { textEN: discoveryAsk(persona, askKeys), stage, strategy: "discovery:ask" };
      }
      return { textEN: discoveryAsk(persona, miss), stage, strategy: "discovery:remind" };
    }

    // demo once (different for agency vs candidate)
    const demoShown = await wasAsked(sessionId, "demo_shown");
    if (!demoShown.asked){
      await markAsked(sessionId, ["demo_shown"]);
      const textEN = profile?.lead_type === "agency" ? demoTextAgency() : demoTextCandidate();
      return { textEN, stage, strategy: "discovery:demo" };
    }

    // go next
    await pool.query("UPDATE public.sessions SET stage='specifics', updated_at=NOW() WHERE id=$1", [sessionId]);
    stage = "specifics";
  }

  /* SPECIFICS — ask for confirming docs once */
  if (stage === "specifics"){
    const asked = await wasAsked(sessionId, "specifics_ask");
    if (!asked.asked){
      await markAsked(sessionId, ["specifics_ask"]);
      return { textEN: specificsAsk(), stage, strategy: "specifics:ask_docs" };
    }
  }

  return null; // let general router (KB/LLM) handle it
}