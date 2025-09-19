// /src/playbook.js
// Dialogue stages (intro → discovery → specifics) with anti-repeat flags.
// Copy is EN-only; reply.js will translate to the conversation language.

import { pool } from "./db.js";
import { getSessionProfile } from "./memory.js";

/* ─────────────────────────────────────────────────────────────
 * Direct languages (others → EN with a translator notice handled in reply.js)
 * ────────────────────────────────────────────────────────────*/
export const DIRECT_LANGS = new Set(["en", "ru", "pl", "cs"]);

/* ─────────────────────────────────────────────────────────────
 * asked_fields / asked_attempts helpers (avoid nagging)
 * ────────────────────────────────────────────────────────────*/
async function getAskedState(sessionId){
  const { rows } = await pool.query(
    "SELECT asked_fields, asked_attempts FROM public.sessions WHERE id=$1",
    [sessionId]
  );
  const s = rows[0] || {};
  return {
    fields: s.asked_fields || {},
    attempts: s.asked_attempts || {}
  };
}
async function wasAsked(sessionId, key){
  const { fields, attempts } = await getAskedState(sessionId);
  return { asked: !!fields[key], attempts: attempts[key] || 0 };
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

/* ─────────────────────────────────────────────────────────────
 * Stage helpers
 * ────────────────────────────────────────────────────────────*/
export async function getStage(sessionId){
  const { rows } = await pool.query("SELECT stage FROM public.sessions WHERE id=$1",[sessionId]);
  return rows[0]?.stage || "intro";
}
export async function setStage(sessionId, stage){
  await pool.query("UPDATE public.sessions SET stage=$2, updated_at=NOW() WHERE id=$1", [sessionId, stage]);
}

/* ─────────────────────────────────────────────────────────────
 * Persona CTA sugar (keeps tone consistent with user psychotype)
 * ────────────────────────────────────────────────────────────*/
function personaCTA(persona, short, cta){
  const T = {
    commander: (a,c)=>`${a?a+"\n":""}Plan: ${c||"country, roles, monthly volume — then a pilot."}`,
    diplomat:  (a,c)=>`${a?a+"\n":""}Precisely: ${c||"share country/roles/volume and I’ll adapt."}`,
    humanist:  (a,c)=>`${a?("I hear you. "+a+"\n"):""}I’ll keep it easy — ${c||"send a couple of details and I’ll steer next steps."}`,
    star:      (a,c)=>`${a?a+"\n":""}Short: ${c||"country + roles + volume — I’ll propose a pilot."}`,
    default:   (a,c)=>`${a?a+"\n":""}${c||"Please share country, roles and monthly volume."}`
  };
  return (T[persona] || T.default)(short, cta);
}

/* ─────────────────────────────────────────────────────────────
 * Copy blocks (EN only, no markdown bold)
 * ────────────────────────────────────────────────────────────*/
function greetText(name){
  return `Hi${name?`, ${name}`:""} — Viktor from RenovoGo. We help with legal EU job placement and business setup. Thanks for reaching out. What’s the context on your side?`;
}

function discoveryAsk(persona, missing){
  // friendly, human phrasing + tiny bullets
  const map = {
    country:   "country (where you operate/focus)",
    role:      "roles you handle",
    candidates:"monthly volume (approx.)"
  };
  const bullets = missing.map(k => `• ${map[k] || k}`).join("\n");
  const text = `To tailor it, a couple of quick points:\n${bullets}\nI’ll adapt to your model and suggest a pilot.`;
  return personaCTA(persona, "", text);
}

function demoText(){
  return `How we run it:
1) Quick case check and docs.
2) Terms: compliance, timelines, responsibility.
3) Start with a pilot (1 candidate) — fast, transparent, low-risk.
Share your current flow and I’ll map our side to it.`;
}

/* ─────────────────────────────────────────────────────────────
 * Main stage engine
 * returns: { textEN, stage, strategy } | null (let router handle)
 * ────────────────────────────────────────────────────────────*/
export async function handleByStage({ sessionId, userTextEN, convLang, persona = "default" }) {
  let stage  = await getStage(sessionId);
  const prof = await getSessionProfile(sessionId);
  const name = (prof?.user_name || "").trim();

  /* ── INTRO ─────────────────────────────────────────────── */
  if (stage === "intro"){
    const greeted = await wasAsked(sessionId, "intro_greeted");
    if (!greeted.asked){
      await markAsked(sessionId, ["intro_greeted"]);
      return { textEN: greetText(name || null), stage, strategy: "intro:greet" };
    }
    // do NOT force name if user already gave one; ask max twice elsewhere in reply.js
    await setStage(sessionId, "discovery");
    stage = "discovery";
  }

  /* ── DISCOVERY ─────────────────────────────────────────── */
  if (stage === "discovery"){
    // If user already hinted B2B, show a partner-friendly intro once
    if (prof?.intent_main === "business_b2b") {
      const asked = await wasAsked(sessionId, "b2b_intro");
      if (!asked.asked){
        await markAsked(sessionId, ["b2b_intro"]);
        return {
          textEN:
`Got it — B2B partnership. A few quick lines so I tune the offer:
• Which region/market do you cover now?
• Typical roles you place?
• Monthly volume you can send?
I’ll outline compliance, permits and a small pilot.`,
          stage, strategy: "discovery:b2b_intro"
        };
      }
    }

    // Otherwise collect minimal facts
    const missing = [];
    if (!prof?.country_interest)   missing.push("country");
    if (!prof?.intent_main)        missing.push("role");
    if (!prof?.candidates_planned) missing.push("candidates");

    if (missing.length){
      // Ask each bucket at most once
      const askKeys = [];
      for (const k of missing){
        const was = await wasAsked(sessionId, `ask_${k}`);
        if (was.attempts < 1) askKeys.push(k);
      }
      if (askKeys.length){
        await markAsked(sessionId, askKeys.map(k => `ask_${k}`));
        return { textEN: discoveryAsk(persona, askKeys), stage, strategy: "discovery:ask" };
      }
      // gentle reminder (still human)
      return { textEN: discoveryAsk(persona, missing), stage, strategy: "discovery:remind" };
    }

    // facts are present → mini demo once
    const demoShown = await wasAsked(sessionId, "demo_shown");
    if (!demoShown.asked){
      await markAsked(sessionId, ["demo_shown"]);
      return { textEN: demoText(), stage, strategy: "discovery:demo" };
    }

    await setStage(sessionId, "specifics");
    stage = "specifics";
  }

  /* ── SPECIFICS ─────────────────────────────────────────── */
  if (stage === "specifics"){
    const asked = await wasAsked(sessionId, "specifics_ask");
    if (!asked.asked){
      await markAsked(sessionId, ["specifics_ask"]);
      return {
        textEN:
"Please share what you already have: website/card, sample role or contract outline, expected rate and timelines — I’ll propose a small pilot and sync our process.",
        stage, strategy: "specifics:ask_docs"
      };
    }
  }

  // No stage output → let general router (KB/LLM) handle it
  return null;
}