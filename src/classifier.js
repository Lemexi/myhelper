// /src/playbook.js
// Conversational playbook: intro → discovery → demo → specifics.
// Human-like tone with persona styles; one-question-at-a-time; no markdown bold.

import { pool } from "./db.js";
import { getSessionProfile } from "./memory.js";

// Direct languages we can speak without translator notice.
// (Reply layer will translate EN → user language when needed.)
export const DIRECT_LANGS = new Set(["en", "ru", "pl", "cs"]);

/* --------------------- asked flags: anti-repeat --------------------- */
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

/* --------------------- stage helpers --------------------- */
export async function getStage(sessionId){
  const { rows } = await pool.query("SELECT stage FROM public.sessions WHERE id=$1", [sessionId]);
  return rows[0]?.stage || "intro";
}
export async function setStage(sessionId, stage){
  await pool.query("UPDATE public.sessions SET stage=$2, updated_at=NOW() WHERE id=$1", [sessionId, stage]);
}

/* --------------------- tiny NLP on EN text --------------------- */
// crude intent signals, works on canonical EN passed from reply.js
function hasAny(s, arr){ const t = (s||"").toLowerCase(); return arr.some(k=>t.includes(k)); }
function detectClientType(textEN){
  const t = (textEN||"").toLowerCase();
  const isB2B = hasAny(t, ["agency", "recruiter", "b2b", "candidates", "office", "we hire", "our clients"]);
  const isB2C = hasAny(t, ["i need a job", "looking for a job", "for myself", "cv", "resume"]);
  if (isB2B && !isB2C) return "b2b";
  if (isB2C && !isB2B) return "b2c";
  return null;
}
function detectCountryMention(textEN){
  const m = (textEN||"").match(/\b(czech|poland|polish|czechia|lithuania|latvia|estonia|germany|netherlands|france|italy)\b/i);
  return m ? m[0].toLowerCase() : null;
}
function detectCandidatesCount(textEN){
  const m = (textEN||"").match(/\b(\d{1,3})\s+(candidates|people|workers)\b/i);
  return m ? parseInt(m[1],10) : null;
}
function detectUserSaysMyNameIs(textEN){
  const m = (textEN||"").match(/\b(my name is|i am)\s+([a-z][a-z'-]{1,30})(\s+[a-z'-]{1,30})?/i);
  return m ? m[2][0].toUpperCase()+m[2].slice(1) : null;
}

/* --------------------- persona tone layer --------------------- */
function tone(persona){
  // micro-variations by style; all short, human-sounding
  switch (persona){
    case "star":
      return {
        warm: (s)=>`Love it. ${s}`,
        greet: (n)=>`Hey${n?`, ${n}`:""}! I’m Viktor from RenovoGo.`,
        bridge: (s)=>`${s} By the way, great direction.`,
        returnToGoal: (s)=>`${s} Let’s make it practical in one step.`
      };
    case "commander":
      return {
        warm: (s)=>s,
        greet: (n)=>`Hello${n?`, ${n}`:""}. Viktor here from RenovoGo.`,
        bridge: (s)=>s,
        returnToGoal: (s)=>`${s} Next: one detail and we move.`
      };
    case "diplomat":
      return {
        warm: (s)=>`Appreciate the context. ${s}`,
        greet: (n)=>`Good to meet you${n?`, ${n}`:""}. I’m Viktor from RenovoGo.`,
        bridge: (s)=>`${s} Thanks for sharing.`,
        returnToGoal: (s)=>`${s} May I clarify one point?`
      };
    case "humanist":
      return {
        warm: (s)=>`I hear you. ${s}`,
        greet: (n)=>`Hi${n?`, ${n}`:""}. I’m Viktor from RenovoGo.`,
        bridge: (s)=>`${s} That makes sense.`,
        returnToGoal: (s)=>`${s} Let’s keep it easy, step by step.`
      };
    default:
      return {
        warm: (s)=>s,
        greet: (n)=>`Hi${n?`, ${n}`:""}. I’m Viktor from RenovoGo.`,
        bridge: (s)=>s,
        returnToGoal: (s)=>s
      };
  }
}

/* --------------------- stock texts (EN only) --------------------- */
function greetBlock(name){
  // playful mirror if same name Viktor
  if (name && name.toLowerCase().startsWith("viktor"))
    return `Nice to meet you, Viktor — fun coincidence, that’s my name too. I help with legal EU employment and business setup.`;
  return `Nice to meet you${name?`, ${name}`:""}. I help with legal EU employment and business setup.`;
}

function askClientType(){
  return "Quick check so I guide you right: are you an agency/recruiter (B2B) or an individual looking for a job (for yourself)? Reply in 1–2 lines.";
}

function askCountry(){
  return "Which EU country is relevant now?";
}
function askB2BVolume(){
  return "Roughly how many candidates per month do you handle?";
}
function askB2CProfile(){
  return "What role or profession are you targeting, and what experience level?";
}

function demoB2B(){
  return `How we usually help agencies:
• Markets: Czech Republic and Poland.
• Full cycle: legal work permits, onboarding, embassy slots where possible.
• Start with a small pilot (1–3 people), then scale.
If this fits, I’ll outline terms in simple steps.`;
}
function demoB2C(){
  return `Here’s how it works for an individual:
• Focus on legal job options in the EU (Czech Republic / Poland).
• We review your profile and documents, discuss timelines and conditions.
• Start with the first vacancy that matches, then move forward.
If that’s fine, I’ll ask one practical thing next.`;
}

function askSpecificsDocs(){
  return "Please share what you have: website/card, sample contract/role, expected rate and timelines — I’ll propose a pilot.";
}

/* --------------------- MAIN ENGINE --------------------- */
export async function handleByStage({ sessionId, userTextEN, convLang, persona }) {
  const style = tone(persona || "default");
  const stage = await getStage(sessionId);
  const profile = await getSessionProfile(sessionId);
  const name = (profile?.user_name || detectUserSaysMyNameIs(userTextEN) || "").trim();

  // INTRO: greet once; if user already gave intro/context, mirror it lightly.
  if (stage === "intro"){
    const greeted = await wasAsked(sessionId, "intro_greeted");
    if (!greeted.asked){
      await markAsked(sessionId, ["intro_greeted"]);
      const textEN = `${style.greet(name)} ${greetBlock(name)} ${style.bridge("")}${askClientType()}`;
      return { textEN: textEN.trim(), stage, strategy: "intro:greet" };
    }
    // If we’re still in intro but name is missing, reply.js will ask name;
    // Here we gently move to discovery after first turn.
    await setStage(sessionId, "discovery");
  }

  // DISCOVERY: figure out client type, country, then branch.
  if (stage === "discovery"){
    // 1) client type
    const clientType = detectClientType(userTextEN) || profile?.intent_main; // reuse if was saved as rough signal
    if (!clientType){
      const was = await wasAsked(sessionId, "ask_client_type");
      if (!was.asked){
        await markAsked(sessionId, ["ask_client_type"]);
        return { textEN: style.returnToGoal(askClientType()), stage, strategy: "discovery:client_type" };
      }
    }

    // 2) country (common for both types)
    const countryFromMsg = detectCountryMention(userTextEN);
    const hasCountry = profile?.country_interest || countryFromMsg;
    if (!hasCountry){
      const was = await wasAsked(sessionId, "ask_country");
      if (!was.asked){
        await markAsked(sessionId, ["ask_country"]);
        return { textEN: style.returnToGoal(askCountry()), stage, strategy: "discovery:country" };
      }
    }

    // 3) branch-specific one more light question, then demo
    if ((clientType || "").toLowerCase() === "b2b" || hasAny(userTextEN, ["agency", "recruiter"])){
      const vol = detectCandidatesCount(userTextEN) || profile?.candidates_planned;
      if (!vol){
        const was = await wasAsked(sessionId, "ask_b2b_volume");
        if (!was.asked){
          await markAsked(sessionId, ["ask_b2b_volume"]);
          return { textEN: style.warm(askB2BVolume()), stage, strategy: "discovery:b2b_volume" };
        }
      }
      // DEMO for B2B once
      const demoShown = await wasAsked(sessionId, "demo_shown");
      if (!demoShown.asked){
        await markAsked(sessionId, ["demo_shown"]);
        return { textEN: style.warm(demoB2B()), stage, strategy: "demo:b2b" };
      }
      await setStage(sessionId, "specifics");
    } else {
      // B2C (individual)
      const wasProfile = await wasAsked(sessionId, "ask_b2c_profile");
      if (!wasProfile.asked && !hasAny(userTextEN, ["driver", "welder", "cook", "nurse", "programmer", "it", "builder", "warehouse", "operator"])){
        await markAsked(sessionId, ["ask_b2c_profile"]);
        return { textEN: style.warm(askB2CProfile()), stage, strategy: "discovery:b2c_profile" };
      }
      const demoShown = await wasAsked(sessionId, "demo_shown");
      if (!demoShown.asked){
        await markAsked(sessionId, ["demo_shown"]);
        return { textEN: style.warm(demoB2C()), stage, strategy: "demo:b2c" };
      }
      await setStage(sessionId, "specifics");
    }
  }

  // SPECIFICS: ask once for confirming docs and inputs
  if (stage === "specifics"){
    const asked = await wasAsked(sessionId, "specifics_ask");
    if (!asked.asked){
      await markAsked(sessionId, ["specifics_ask"]);
      return { textEN: style.returnToGoal(askSpecificsDocs()), stage, strategy: "specifics:ask_docs" };
    }
    // after this, general router (KB/LLM) can handle free questions
  }

  // No special playbook output → let router handle.
  return null;
}