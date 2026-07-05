// Shared parsing helpers for Discord attendance/work messages.
//
// These were previously duplicated (and had diverged) between
// src/modules/monitor/collector.js (live ingestion) and
// src/modules/dashboard/server.js (reload/backfill endpoints), which meant the
// SAME Discord message could be classified differently depending on whether it
// was captured live or re-ingested via a reload/backfill. This module is the
// single source of truth so live ingestion and reload/backfill always agree.
//
// The canonical behavior is the live-collector behavior (the authoritative
// path): parseAttendanceState/parseWorkState/extractScheduleInfo match the
// former collector implementations verbatim, and extractAttendanceName is the
// UNION of both former pattern sets (specific-first) so no path loses the
// ability to extract a name it could extract before.

function compact(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function parseAttendanceState(text) {
  const src = String(text || '');
  const t = src.toLowerCase();

  if (/cancelled|취소됨/.test(t)) return 'cancelled';

  // 우선순위: 문장형 고정 패턴 (예: "... 출근했습니다.", "... 퇴근했습니다.")
  if (/출근\s*했습니다\.?/.test(src)) return '출근';
  if (/퇴근\s*했습니다\.?/.test(src)) return '퇴근';

  if (/퇴근|off|leave work/.test(t)) return '퇴근';
  if (/출근|on\s?duty|check\s?in/.test(t)) return '출근';
  if (/지각|late/.test(t)) return '지각';
  if (/재택근무|재택|remote|wfh|work from home/.test(t)) return '재택근무';
  if (/오전\s*반차|am\s*half/.test(t)) return '오전반차';
  if (/오후\s*반차|pm\s*half/.test(t)) return '오후반차';
  if (/반차/.test(t)) return '반차';
  if (/휴가|연차|pto|vacation/.test(t)) return '휴가';
  if (/외근|자리비움|away|afk/.test(t)) return '자리비움';
  if (/복귀|back/.test(t)) return '복귀';
  return '업데이트';
}

function parseWorkState(text) {
  const t = (text || '').toLowerCase();
  if (/완료|done|finished|resolved/.test(t)) return '완료';
  if (/진행|in\s?progress|working/.test(t)) return '진행중';
  if (/대기|보류|pending|hold/.test(t)) return '대기';
  if (/막힘|이슈|blocked|issue/.test(t)) return '이슈';
  if (/리뷰|review/.test(t)) return '리뷰중';
  return '업데이트';
}

// Join a Discord message's text content plus any embed title/description/fields.
function getMessageText(message) {
  const chunks = [];
  if (message?.content) chunks.push(message.content);
  for (const e of message?.embeds || []) {
    if (e.title) chunks.push(e.title);
    if (e.description) chunks.push(e.description);
    for (const f of e.fields || []) {
      if (f?.name) chunks.push(f.name);
      if (f?.value) chunks.push(f.value);
    }
  }
  return chunks.join(' ');
}

// Same as getMessageText but compacted, with a fallback placeholder used when a
// message carries only attachments/embeds without extractable text.
function getAttendanceSourceText(message) {
  return compact(getMessageText(message)) || '(첨부/임베드 메시지)';
}

// Union of the former collector (4) and dashboard (8) pattern sets, ordered
// specific/anchored-first so the most reliable formats win. This is a strict
// superset of both previous implementations.
const ATTENDANCE_NAME_PATTERNS = [
  // Dated WantedSpace format: "3월 4일(수) 이상민 ... 출근했습니다."
  /^\d{1,2}월\s*\d{1,2}일(?:\([^)]*\))?\s+([가-힣A-Za-z]{2,12})/,
  // Bracketed name: "[ 홍길동 ] ..."
  /^\[\s*([^\]]{2,20})\s*\]/,
  // Labelled: "이름: 홍길동" / "성명: 홍길동"
  /(?:이름|성명)\s*[:：]\s*([가-힣A-Za-z][가-힣A-Za-z0-9._ -]{1,19})/,
  // "홍길동: 출근" / "홍길동 - 퇴근"
  /^([가-힣A-Za-z][가-힣A-Za-z0-9._ -]{1,19})\s*[:：\-]\s*(?:출근|퇴근|휴가|지각|외근|복귀|반차|연차|재택근무)/,
  // Leave-like at start: "박정우 재택근무"
  /^([가-힣A-Za-z]{2,12})\s+(?:재택근무|연차|반차|휴가)\b/,
  // Basic at start (includes bare 근무): "홍길동 출근"
  /^([가-힣A-Za-z]{2,12})\s+(?:근무|출근|퇴근|휴가|지각|외근|복귀)/,
  // Korean-only basic at start
  /^([가-힣]{2,4})\s+(?:출근|퇴근|휴가|지각|외근|복귀|반차|연차|재택근무)/,
  // Name + honorific particle: "이상민 님이 출근했습니다" -> 이상민 (captures the name,
  // not the particle, so the honorific is never mistaken for the name).
  /([가-힣A-Za-z]{2,12})\s*님(?:이|은|을|를|의|과|도|들|께서)?(?:\s|$)/,
  // Name (+님) + state anywhere: "홍길동 님 퇴근"
  /([가-힣A-Za-z]{2,12})\s*(?:님)?\s*(?:출근|퇴근|휴가|지각|외근|복귀|반차|연차|재택근무)/,
  // Leave-like anywhere
  /([가-힣A-Za-z]{2,12})\s+(?:재택근무|연차|반차|휴가)\b/,
];

// A standalone honorific token (e.g. "님", "님이", "씨") is never a real name;
// guard against the broad "anywhere" patterns capturing it.
const BARE_HONORIFIC = /^(?:님|씨)(?:이|은|을|를|의|과|도|들|께서)?$/;

function extractAttendanceName(text) {
  const t = compact(text || '');
  if (!t) return null;

  // 임베드/마크다운 기호 제거 (굵게, 백틱, 괄호 등)
  const cleaned = t.replace(/[*_`~\[\]]/g, ' ').replace(/\s+/g, ' ').trim();

  for (const p of ATTENDANCE_NAME_PATTERNS) {
    const m = cleaned.match(p);
    const name = m?.[1]?.trim();
    if (name && !BARE_HONORIFIC.test(name)) return name;
  }
  return null;
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
    // Discord 유닉스 타임스탬프 포맷: <t:1773187200:F>
    const discordTs = dateRaw.match(/<t:(\d+)(?::[^>]*)?>/) || t.match(/<t:(\d+)(?::[^>]*)?>/);
    if (discordTs) {
      scheduledFor = new Date(Number(discordTs[1]) * 1000).toISOString();
    } else {
      // 영어 날짜 시도 (e.g. "Tuesday, March 10, 2026")
      const parsed = new Date(dateRaw);
      if (!Number.isNaN(parsed.getTime())) {
        scheduledFor = parsed.toISOString();
      } else {
        // 한국어 날짜 파싱 (e.g. "2026년 3월 10일 화요일 오전 9:00")
        const korMatch = dateRaw.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/);
        if (korMatch) {
          const [, y, m, d] = korMatch;
          scheduledFor = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d))).toISOString();
        }
      }
    }
  }

  return { scheduledFor, durationText };
}

module.exports = {
  compact,
  parseAttendanceState,
  parseWorkState,
  getMessageText,
  getAttendanceSourceText,
  extractAttendanceName,
  extractScheduleInfo,
};
