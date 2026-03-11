require('dotenv').config();
const { JSONFileSync } = require('lowdb/node');
const { LowSync } = require('lowdb');
const { DB_FILE } = require('../src/core/paths');
const pgStore = require('../src/core/pg-store');

const OLLAMA_API_BASE = String(process.env.OLLAMA_API_BASE || 'http://127.0.0.1:11434').replace(/\/$/, '');
const OLLAMA_SUMMARY_MODEL = String(process.env.OLLAMA_SUMMARY_MODEL || 'qwen2.5:1.5b').trim();
const WORK_SUMMARY_MAX_CHARS = Math.max(12, Number(process.env.WORK_SUMMARY_MAX_CHARS || 30));
const WORK_SUMMARY_MIN_CHARS = Math.max(1, Number(process.env.WORK_SUMMARY_MIN_CHARS || 20));

function compact(text) { return String(text || '').replace(/\s+/g, ' ').trim(); }
function clampSummary(text) {
  const s = compact(text);
  if (s.length <= WORK_SUMMARY_MAX_CHARS) return s;
  return `${s.slice(0, WORK_SUMMARY_MAX_CHARS - 1)}…`;
}

async function summarize(raw) {
  if (compact(raw).length < WORK_SUMMARY_MIN_CHARS) return clampSummary(raw);
  const prompt = `아래 업무 메시지를 한국어 1문장, 30자 이하로 요약하라.\n규칙:\n- 고유명사/개인정보/URL 제거\n- 과장/추측 금지\n- 의미가 불명확하면 핵심 키워드만 간결히\n- 출력은 요약 문장만\n원문: ${raw}`;
  try {
    const res = await fetch(`${OLLAMA_API_BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_SUMMARY_MODEL, prompt, stream: false, options: { temperature: 0.2, num_predict: 80 } }),
    });
    if (!res.ok) return clampSummary(raw);
    const data = await res.json();
    return clampSummary(data?.response || raw);
  } catch {
    return clampSummary(raw);
  }
}

(async () => {
  const adapter = new JSONFileSync(DB_FILE);
  const db = new LowSync(adapter, { users: [], events: [], attendanceByName: {}, nameMappings: {}, meta: {} });
  db.read();
  db.data ||= { users: [], events: [], attendanceByName: {}, nameMappings: {}, meta: {} };

  const events = db.data.events || [];
  const targets = events.filter((e) => e.kind === 'work' && e.summary);
  let updated = 0;

  for (const e of targets) {
    const short = await summarize(e.summary);
    if (!short) continue;
    e.summaryShort = short;

    for (const u of db.data.users || []) {
      if (u?.work?.messageId === e.messageId) u.work.summaryShort = short;
      for (const w of (u?.workLogs || [])) {
        if (w?.messageId === e.messageId) w.summaryShort = short;
      }
    }

    if (pgStore.pgEnabled) {
      await pgStore.insertEvent({ ...e, raw_payload: { ...(e.raw_payload || {}), summaryShort: short } }).catch(() => null);
    }
    updated += 1;
  }

  db.write();
  console.log(JSON.stringify({ ok: true, updated, totalWorkEvents: targets.length }, null, 2));
})();
