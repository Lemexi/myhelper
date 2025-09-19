// Dialogue stages (intro → discovery → specifics → …) with lightweight anti-repeat.
// All copy is in EN; reply.js will translate to user language when needed.

import { pool } from "./db.js";
import { getSessionProfile } from "./memory.js";

// Supported direct languages. Others => English with a small notice.
export const DIRECT_LANGS = ["en", "ru", "pl", "cs"];

// --- asked flags helpers (avoid nagging) --------------------
async function getAskedState(sessionId){
  const { rows } = await pool.query(
    "SELECT asked_fields, asked_attempts, stage FROM public.sessions WHERE id=$1",
    [sessionId]
  );
  const s = rows[0] || {};
  return {
    fields: s.asked_fields || {},
    attempts: s.asked_attempts || {},
    stage: s.stage || "intro",
  };
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

// --- stage helpers ------------------------------------------
export async function getStage(sessionId){
  const { rows } = await pool.query("SELECT stage FROM public.sessions WHERE id=$1", [sessionId]);
  return rows[0]?.stage || "intro";
}
export async function setStage(sessionId, stage){
  await pool.query("UPDATE public.sessions SET stage=$2, updated_at=NOW() WHERE id=$1", [sessionId, stage]);
}

// --- persona CTA sugar --------------------------------------
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

// --- stage texts (EN only) ----------------------------------
function greetText(name){
  return `Hi${name?`, ${name}`:""}! I'm Viktor from RenovoGo. We help with legal EU job placement and business setup. How can I help right now?`;
}
function discoveryAsk(persona, missing){
  const short = (missing.length === 1) ? `Need: ${missing[0]}` : `Need: ${missing.join(", ")}`;
  const cta   = "Please send and I will continue.";
  return personaCTA(persona, short, cta);
}
function demoText(){
  return `How we work:
1) Verify the case and documents.
2) Agree on contract type/timelines and responsibility.
3) Start with a pilot (1 candidate) — fast and transparent.
Let’s close missing items and move to terms.`;
}

// --- main stage engine --------------------------------------
export async function handleByStage({ sessionId, persona }) {
  const stage = await getStage(sessionId);
  const profile = await getSessionProfile(sessionId);
  const name  = (profile?.user_name || "").trim();

  // INTRO — greet once; ask name at most twice
  if (stage === "intro"){
    const greeted = await wasAsked(sessionId, "intro_greeted");
    if (!greeted.asked){
      await markAsked(sessionId, ["intro_greeted"]);
      return { textEN: greetText(name || null), stage, strategy: "intro:greet" };
    }
    if (!name){
      const asked = await wasAsked(sessionId, "user_name");
      if (asked.attempts < 2){
        await markAsked(sessionId, ["user_name"]);
        return { textEN: "How should I address you?", stage, strategy: "intro:ask_name" };
      }
    }
    await setStage(sessionId, "discovery");
  }

  // DISCOVERY — collect country, role(intent), candidates
  if (stage === "discovery"){
    const miss = [];
    if (!profile?.country_interest)   miss.push("country");
    if (!profile?.intent_main)        miss.push("role");
    if (!profile?.candidates_planned) miss.push("candidates");

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

    // Once facts are present, show mini-demo once
    const demoShown = await wasAsked(sessionId, "demo_shown");
    if (!demoShown.asked){
      await markAsked(sessionId, ["demo_shown"]);
      return { textEN: demoText(), stage, strategy: "discovery:demo" };
    }
    await setStage(sessionId, "specifics");
  }

  // SPECIFICS — ask for confirming docs once
  if (stage === "specifics"){
    const asked = await wasAsked(sessionId, "specifics_ask");
    if (!asked.asked){
      await markAsked(sessionId, ["specifics_ask"]);
      return {
        textEN: "Please share what you have: website/card, sample contract/role, expected rate and timelines — I’ll propose a pilot.",
        stage, strategy: "specifics:ask_docs"
      };
    }
  }

  return null; // let general router (KB/LLM) handle it
}