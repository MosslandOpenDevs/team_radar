require('dotenv').config();
const pgStore = require('../src/core/pg-store');

const OLLAMA_API_BASE = String(process.env.OLLAMA_API_BASE || 'http://127.0.0.1:11434').replace(/\/$/, '');
const OLLAMA_SUMMARY_MODEL = String(process.env.OLLAMA_SUMMARY_MODEL || 'qwen2.5:1.5b').trim();
const WORK_SUMMARY_MIN_CHARS = Math.max(1, Number(process.env.WORK_SUMMARY_MIN_CHARS || 20));
const WORK_SUMMARY_MAX_CHARS = Math.max(12, Number(process.env.WORK_SUMMARY_MAX_CHARS || 30));

function compact(text) { return String(text || '').replace(/\s+/g, ' ').trim(); }
function clamp(text) { const s=compact(text); return s.length<=WORK_SUMMARY_MAX_CHARS?s:`${s.slice(0, WORK_SUMMARY_MAX_CHARS-1)}…`; }

async function summarize(raw) {
  const t = compact(raw);
  if (!t) return '';
  if (t.length < WORK_SUMMARY_MIN_CHARS) return clamp(t);
  const prompt = `아래 업무 메시지를 한국어 1문장, 30자 이하로 요약하라.\n규칙:\n- 고유명사/개인정보/URL 제거\n- 과장/추측 금지\n- 의미가 불명확하면 핵심 키워드만 간결히\n- 출력은 요약 문장만\n원문: ${t}`;
  try {
    const r = await fetch(`${OLLAMA_API_BASE}/api/generate`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ model: OLLAMA_SUMMARY_MODEL, prompt, stream:false, options:{temperature:0.2, num_predict:80} })
    });
    if (!r.ok) return clamp(t);
    const j = await r.json();
    return clamp(j?.response || t);
  } catch {
    return clamp(t);
  }
}

(async()=>{
  if (!pgStore.pgEnabled) throw new Error('Postgres not enabled');
  const logs = await pgStore.getLogs(2000);
  const targets = (logs.rows||[]).filter(r => r.kind==='work' && r.summary && !r.summaryShort);
  let updated=0;
  for (const r of targets) {
    const summaryShort = await summarize(r.summary);
    await pgStore.insertEvent({
      userId: r.userId, displayName: r.displayName, kind:'work', state:r.state,
      summary:r.summary, summaryShort,
      channelId:r.channelId, messageId:r.messageId, at:r.at,
      raw_payload: { summaryShort },
    });
    updated++;
  }
  console.log(JSON.stringify({ok:true, updated, totalTargets:targets.length}, null, 2));
})();
