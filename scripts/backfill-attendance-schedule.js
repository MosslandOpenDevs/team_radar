require('dotenv').config();
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const DAYS = Math.max(1, Math.min(90, Number(process.argv[2] || 30)));
const pool = new Pool({ connectionString: DATABASE_URL });

function compact(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function extractScheduleInfo(text) {
  const t = compact(text || '');
  if (!t) return { scheduledFor: null, durationText: null };

  const dateMatch = t.match(/Scheduled\s*for\s*([^\n]+?)(?:\s+Duration\b|$)/i);
  const durationMatch = t.match(/Duration\s*([^\n]+)$/i);

  const dateRaw = compact(dateMatch?.[1] || '');
  const durationText = compact(durationMatch?.[1] || '') || null;

  let scheduledFor = null;
  if (dateRaw) {
    const parsed = new Date(dateRaw);
    if (!Number.isNaN(parsed.getTime())) scheduledFor = parsed.toISOString();
  }

  return { scheduledFor, durationText };
}

async function main() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `select id, summary, raw_payload
         from events
        where kind = 'attendance'
          and occurred_at >= now() - ($1::text || ' days')::interval`,
      [String(DAYS)]
    );

    let scanned = 0;
    let updated = 0;
    let matched = 0;

    for (const r of rows) {
      scanned += 1;
      const payload = (r.raw_payload && typeof r.raw_payload === 'object') ? { ...r.raw_payload } : {};
      const hasScheduled = !!payload.scheduledFor;
      const hasDuration = !!payload.durationText;
      if (hasScheduled && hasDuration) continue;

      const info = extractScheduleInfo(r.summary || payload.summary || '');
      if (!info.scheduledFor && !info.durationText) continue;
      matched += 1;

      if (!payload.scheduledFor && info.scheduledFor) payload.scheduledFor = info.scheduledFor;
      if (!payload.durationText && info.durationText) payload.durationText = info.durationText;

      await client.query(`update events set raw_payload = $2::jsonb where id = $1`, [r.id, JSON.stringify(payload)]);
      updated += 1;
    }

    console.log(JSON.stringify({ days: DAYS, scanned, matched, updated }, null, 2));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
