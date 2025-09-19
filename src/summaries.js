// summaries.js
import { pool } from './db.js';

export async function fetchRecentSummaries(sessionId, limit = 3) {
  const { rows } = await pool.query(`
    SELECT turn_no, content
    FROM public.summaries
    WHERE session_id = $1
    ORDER BY created_at DESC
    LIMIT $2
  `, [sessionId, limit]);
  return rows;
}
