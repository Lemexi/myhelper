// demand.js
import { db } from './db.js';

export async function upsertDemand(sessionId, payload = {}) {
  // деактивируем прошлый активный
  await db.query(`UPDATE public.session_demand SET is_active=false, updated_at=NOW()
                  WHERE session_id=$1 AND is_active=true`, [sessionId]);

  const { rows } = await db.query(`
    INSERT INTO public.session_demand
      (session_id, country, company_name, position, location_city, visa_type,
       salary_min, salary_max, salary_currency, hours_per_month, schedule_text, period_months,
       accommodation_provided, accommodation_cost, transport_provided, meals_provided,
       candidates_needed, source, raw_json, is_active)
    VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,true)
    RETURNING id
  `, [
    sessionId,
    payload.country || null,
    payload.company_name || null,
    payload.position || null,
    payload.location_city || null,
    payload.visa_type || null,
    payload.salary_min ?? null,
    payload.salary_max ?? null,
    payload.salary_currency || 'EUR',
    payload.hours_per_month ?? null,
    payload.schedule_text || null,
    payload.period_months ?? null,
    payload.accommodation_provided ?? null,
    payload.accommodation_cost ?? null,
    payload.transport_provided ?? null,
    payload.meals_provided ?? null,
    payload.candidates_needed ?? null,
    payload.source || 'user',
    payload.raw_json ?? null
  ]);
  return rows[0].id;
}

export async function setSessionContract(sessionId, demandId, contractId, override = {}) {
  // делаем один активный
  await db.query(`UPDATE public.session_contract SET is_active=false, updated_at=NOW()
                  WHERE session_id=$1 AND is_active=true`, [sessionId]);
  await db.query(`
    INSERT INTO public.session_contract
      (session_id, demand_id, contract_id, price_override, currency_override, notes)
    VALUES ($1,$2,$3,$4,$5,$6)
  `, [
    sessionId, demandId, contractId,
    override.price_override ?? null,
    override.currency_override ?? null,
    override.notes ?? null
  ]);
}
