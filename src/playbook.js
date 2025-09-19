// /src/playbook.js
import { pool } from "./db.js";
import { getSessionProfile, upsertFacts } from "./memory.js";

// Supported direct languages. Others => English with a small notice.
export const DIRECT_LANGS = new Set(["en", "ru", "pl", "cz"]);

// --- asked flags helpers --------------------
async function getAskedState(sessionId){ /* как было */ }
async function markAsked(sessionId, keys){ /* как было */ }
async function wasAsked(sessionId, key){ /* как было */ }

// --- stage helpers --------------------------
export async function getStage(sessionId){ /* как было */ }
export async function setStage(sessionId, stage){ /* как было */ }

// --- NEW: lightweight NLP to infer quick facts from user text (EN)
export async function inferQuickFacts(sessionId, userTextEN){
  if (!userTextEN) return null;
  const t = userTextEN.toLowerCase();

  const facts = {};

  // B2B / agency / recruiter
  if (/\b(b2b|agency|recruit(er|ment)|partnership|cooperation)\b/.test(t) ||
      /агентств|рекрутер|сотрудничеств/i.test(userTextEN)) {
    facts.intent_main = 'business';       // бизнес-намерение
    facts.client_type = 'agency';         // свой флаг (можно хранить в sessions.facts)
  }

  // individual / job seeker
  if (/\b(i am looking for a job|job for myself|for me|individual)\b/.test(t) ||
      /ищу работу для себя|частное лицо/i.test(userTextEN)) {
    facts.intent_main = 'work';
    facts.client_type = 'individual';
  }

  // country hints (EN/ru транслит)
  if (/\bqatar|doha\b/i.test(t) || /катар/i.test(userTextEN)) facts.country_interest = 'QA';
  if (/\bpoland|warsaw|krakow\b/i.test(t) || /польш/i.test(userTextEN)) facts.country_interest = 'PL';
  if (/\bczech|prague\b/i.test(t) || /чех/i.test(userTextEN)) facts.country_interest = 'CZ';

  // rough candidates count
  const m = userTextEN.match(/\b(\d{1,3})\s*(candidates|people|люд|кандидат)/i);
  if (m) facts.candidates_planned = Number(m[1]);

  if (Object.keys(facts).length){
    await upsertFacts(sessionId, facts);
    return facts;
  }
  return null;
}

// --- persona CTA sugar ----------------------
function personaCTA(persona, short, cta){ /* как было */ }

// --- stage texts (EN only) ------------------
function greetText(name){
  // компактное, живое приветствие; без жирного
  const sameNameTwist = name && /^viktor|victor|виктор$/i.test(name) ? " Funny coincidence — same name!" : "";
  return `Hi${name?`, ${name}`:""} — I'm Viktor from RenovoGo.${sameNameTwist} We help with legal EU job placement and business setup. What brought you here?`;
}

function discoveryAsk(persona, missing){
  const short = (missing.length === 1) ? `Need: ${missing[0]}` : `Need: ${missing.join(", ")}`;
  const cta   = "Please send and I will continue.";
  return personaCTA(persona, short, cta);
}

function demoText(isAgency){
  // более «человечная» мини-демка
  if (isAgency){
    return `How we usually work with agencies:
• You share roles and monthly demand (even rough).
• We confirm legal route, timelines and responsibilities.
• Kick off with a pilot (1–3 candidates) to align process.
If this sounds OK — send current roles and expected rate, and I’ll propose a pilot.`;
  }
  return `How we work:
• We verify your case and documents.
• Confirm legal route, timelines and responsibilities.
• Start with a small pilot to keep it fast and clear.
Share your target country/role/rate — I’ll outline next steps.`;
}

// --- main stage engine ----------------------
export async function handleByStage({ sessionId, userTextEN, convLang, persona }) {
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

  // --- BEFORE discovery: use latest message to infer B2B/agency and other quick facts
  await inferQuickFacts(sessionId, userTextEN);
  const fresh = await getSessionProfile(sessionId);
  const isAgency = fresh?.facts?.client_type === 'agency';

  // DISCOVERY — collect country, role(intent), candidates; НЕ спрашиваем «вы агентство?», если уже ясно
  if (stage === "discovery"){
    const miss = [];
    if (!fresh?.country_interest)   miss.push("country");
    if (!fresh?.intent_main)        miss.push("role");
    if (isAgency && !fresh?.candidates_planned) miss.push("candidates");

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

    // Facts are present → show mini-demo once (ветка для агентства — отдельный текст)
    const demoShown = await wasAsked(sessionId, "demo_shown");
    if (!demoShown.asked){
      await markAsked(sessionId, ["demo_shown"]);
      return { textEN: demoText(isAgency), stage, strategy: "discovery:demo" };
    }
    await setStage(sessionId, "specifics");
  }

  // SPECIFICS — ask once
  if (stage === "specifics"){
    const asked = await wasAsked(sessionId, "specifics_ask");
    if (!asked.asked){
      await markAsked(sessionId, ["specifics_ask"]);
      return {
        textEN: isAgency
          ? "Please share: roles you need, monthly volume, expected rate and start dates — I’ll propose a small pilot."
          : "Please share your CV/role, expected rate and timing — I’ll outline your legal route.",
        stage, strategy: "specifics:ask_docs"
      };
    }
  }

  return null; // let general router handle it
}