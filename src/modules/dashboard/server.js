require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { PNG } = require('pngjs');
const { Client, GatewayIntentBits } = require('discord.js');
const { ROOT_DIR, DB_FILE, COLLISION_OVERRIDES_FILE, COLLISION_MASK_FILE } = require('../../core/paths');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const MAP_DIR = path.join(ROOT_DIR, 'map');
const pgStore = require('../../core/pg-store');
const {
  DEFAULT_STATUS_ROOM_MAPPING,
  normalizeStatusRoomMapping,
} = require('../../shared/status-zones');

const PORT = Number(process.env.DASHBOARD_PORT || 3100);
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;
const parseIds = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const ATTENDANCE_CHANNEL_IDS = parseIds(process.env.ATTENDANCE_CHANNEL_IDS);
const ATTENDANCE_NAME_LOOKBACK_DAYS = Math.max(1, Number(process.env.ATTENDANCE_NAME_LOOKBACK_DAYS || 5));

// 근태 채널에서 처리할 봇 ID 및 허용 상태
const WANTEDSPACE_BOT_ID = process.env.WANTEDSPACE_BOT_ID || ''; // wantedspaceBotV2 - 출근/퇴근
const CHRONICLE_BOT_ID = process.env.CHRONICLE_BOT_ID || '';      // ChronicleBot - 연차/반차/재택근무
const WANTEDSPACE_STATES = new Set(['출근', '퇴근', '지각', '복귀', '자리비움']);
const CHRONICLE_SCHEDULE_STATES = new Set(['재택근무', '연차', '반차', '오전반차', '오후반차', '휴가']);
const APP_ACCESS_TOKEN = String(process.env.APP_ACCESS_TOKEN || '').trim();
const AUTH_ENABLED = APP_ACCESS_TOKEN.length > 0;
const SESSION_COOKIE_NAME = 'teamradar_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7d
const SESSION_STORE = new Map(); // sid -> {createdAt, lastSeenAt}

const app = express();
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

function parseCookies(req) {
  const raw = String(req.headers?.cookie || '');
  if (!raw) return {};
  return raw.split(';').map((v) => v.trim()).filter(Boolean).reduce((acc, part) => {
    const idx = part.indexOf('=');
    if (idx <= 0) return acc;
    const k = decodeURIComponent(part.slice(0, idx));
    const v = decodeURIComponent(part.slice(idx + 1));
    acc[k] = v;
    return acc;
  }, {});
}

function constantTimeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function createSession() {
  const sid = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  SESSION_STORE.set(sid, { createdAt: now, lastSeenAt: now });
  return sid;
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

app.get('/login', (req, res) => {
  if (!AUTH_ENABLED) return res.redirect('/map/composed_set_map.html');

  const html = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>TeamRadar Login</title>
  <style>
    body { margin:0; min-height:100vh; display:grid; place-items:center; background:#0d1222; color:#dbe4ff; font-family:system-ui; }
    form { width:min(420px, 92vw); background:#151d38; border:1px solid #2f3f75; border-radius:12px; padding:18px; }
    input, button { width:100%; box-sizing:border-box; border-radius:8px; border:1px solid #3a4f8a; background:#101832; color:#e6eeff; padding:10px 12px; }
    button { margin-top:10px; background:#2a4dc7; border-color:#3d62df; cursor:pointer; }
    #msg { margin-top:10px; font-size:13px; color:#ffb7b7; min-height:18px; }
  </style>
</head>
<body>
  <form id="loginForm">
    <h3 style="margin:0 0 10px 0;">TeamRadar Access</h3>
    <input id="token" type="password" placeholder="Access token" autocomplete="off" required />
    <button type="submit">입장</button>
    <div id="msg"></div>
  </form>
  <script>
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = document.getElementById('msg');
      msg.textContent = '';
      const token = document.getElementById('token').value || '';
      const r = await fetch('/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ token }) });
      if (r.ok) {
        location.href = '/map/composed_set_map.html';
        return;
      }
      msg.textContent = '토큰이 올바르지 않습니다.';
    });
  </script>
</body>
</html>`;
  res.status(200).send(html);
});

app.post('/auth/login', (req, res) => {
  if (!AUTH_ENABLED) return res.json({ ok: true, disabled: true });
  const input = String(req.body?.token || '');
  if (!constantTimeEqual(input, APP_ACCESS_TOKEN)) {
    return res.status(401).json({ ok: false, error: 'invalid_token' });
  }

  const sid = createSession();
  const isSecure = String(req.headers['x-forwarded-proto'] || '').includes('https');
  const cookie = `${SESSION_COOKIE_NAME}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${isSecure ? '; Secure' : ''}`;
  res.setHeader('Set-Cookie', cookie);
  return res.json({ ok: true });
});

app.post('/auth/logout', (req, res) => {
  const sid = parseCookies(req)[SESSION_COOKIE_NAME];
  if (sid) SESSION_STORE.delete(sid);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.use((req, res, next) => {
  if (!AUTH_ENABLED) return next();
  if (req.path === '/login' || req.path === '/auth/login' || req.path === '/healthz') return next();

  const sid = parseCookies(req)[SESSION_COOKIE_NAME];
  const session = sid ? SESSION_STORE.get(sid) : null;
  if (session) {
    if (Date.now() - session.lastSeenAt > SESSION_TTL_MS) {
      SESSION_STORE.delete(sid);
      clearSessionCookie(res);
    } else {
      session.lastSeenAt = Date.now();
      return next();
    }
  }

  const accept = String(req.headers.accept || '');
  if (accept.includes('text/html')) return res.redirect('/login');
  return res.status(401).json({ ok: false, error: 'auth_required' });
});

app.use('/map', express.static(MAP_DIR));
app.use(express.static(PUBLIC_DIR));

let discordClient = null;
let memberCache = [];
let memberCacheAt = null;
let attendanceNameCache = [];
let attendanceNameCacheAt = null;

async function refreshCaches(options = {}) {
  if (!discordClient?.isReady()) return;

  const { includeMembers = true } = options;

  if (includeMembers) {
    const guild = await discordClient.guilds.fetch(DISCORD_GUILD_ID);
    const members = await guild.members.fetch();
    memberCache = [...members.values()]
      .filter((m) => !m.user.bot)
      .map((m) => ({
        userId: m.user.id,
        username: m.user.username,
        globalName: m.user.globalName || null,
        displayName: m.displayName || m.user.username,
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
    memberCacheAt = new Date().toISOString();
    console.log(`[DASHBOARD] member cache loaded: ${memberCache.length}`);
  }

  const sinceMs = Date.now() - ATTENDANCE_NAME_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const attendanceNames = new Set();

  for (const channelId of ATTENDANCE_CHANNEL_IDS) {
    const ch = await discordClient.channels.fetch(channelId).catch(() => null);
    if (!ch || !ch.isTextBased()) continue;

    let before;
    let stop = false;
    while (!stop) {
      const batch = await ch.messages.fetch({ limit: 100, before }).catch(() => null);
      if (!batch || batch.size === 0) break;

      const rows = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      for (const msg of rows) {
        if (msg.createdTimestamp < sinceMs) {
          stop = true;
          continue;
        }
        const picked = extractAttendanceName(getMessageText(msg));
        if (picked) attendanceNames.add(picked);
      }

      before = rows[0]?.id;
      if (!before) break;
    }
  }

  const db = readDb();
  const dbSinceMs = Date.now() - ATTENDANCE_NAME_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  for (const e of db.events || []) {
    if (e.kind !== 'attendance') continue;
    if (!e.at || new Date(e.at).getTime() < dbSinceMs) continue;
    const picked = e.attendanceName || extractAttendanceName(e.summary || e.rawText || '');
    if (picked) attendanceNames.add(picked);
  }

  for (const u of db.users || []) {
    const picked = u.attendance?.attendanceName || extractAttendanceName(u.attendance?.rawText || '');
    if (picked) attendanceNames.add(picked);
  }

  attendanceNameCache = [...attendanceNames].sort((a, b) => a.localeCompare(b, 'ko'));
  attendanceNameCacheAt = new Date().toISOString();
  console.log(`[DASHBOARD] attendance-name cache loaded: ${attendanceNameCache.length}`);
}

async function initDiscordMemberCache() {
  if (!BOT_TOKEN || !DISCORD_GUILD_ID) {
    console.log('[DASHBOARD] Discord member list disabled (set DISCORD_BOT_TOKEN + DISCORD_GUILD_ID)');
    return;
  }

  discordClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  discordClient.once('ready', async () => {
    try {
      await refreshCaches();
    } catch (err) {
      console.warn('[DASHBOARD] failed to load members:', err.message);
    }
  });

  await discordClient.login(BOT_TOKEN).catch((err) => {
    console.warn('[DASHBOARD] discord login failed:', err.message);
  });
}

function readDb() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      return {
        users: [],
        events: [],
        meta: { createdAt: null, updatedAt: null },
      };
    }
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    parsed.users ||= [];
    parsed.events ||= [];
    parsed.nameMappings ||= {};
    parsed.attendanceNameToUserId ||= {};
    parsed.attendanceMappings ||= {};
    parsed.attendanceByName ||= {};
    parsed.characterSelections ||= {};
    parsed.meta ||= { createdAt: null, updatedAt: null };
    return parsed;
  } catch (err) {
    return {
      users: [],
      events: [],
      meta: { createdAt: null, updatedAt: null, error: err.message },
    };
  }
}

app.get('/api/team/status', async (req, res) => {
  const hideBots = String(req.query.hideBots || '').toLowerCase() === '1' || String(req.query.hideBots || '').toLowerCase() === 'true';

  if (pgStore.pgEnabled) {
    try {
      const status = await pgStore.getDashboardStatus();
      const logs = await pgStore.getLogs(5000);
      const effectiveUsers = applyEffectiveAttendance(status.users || [], logs.rows || [], status.attendanceNameToUserId || {});
      const users = hideBots ? effectiveUsers.filter((u) => !isBotLikeUser(u)) : effectiveUsers;
      const summary = buildSummary(users);
      return res.json({ now: new Date().toISOString(), ...status, users, summary });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  const db = readDb();
  const attendanceNameToUserId = db.attendanceNameToUserId || {};
  const attendanceMappings = db.attendanceMappings || {};
  const todayAttendanceByName = getTodayKstAttendanceByName(db);
  const userIdToAttendance = Object.fromEntries(
    Object.entries(attendanceMappings).map(([att, row]) => [row?.userId || attendanceNameToUserId[att], att])
  );

  let users = [...db.users]
    .map((u) => ({
      ...u,
      attendanceAlias: userIdToAttendance[u.userId] || db.nameMappings?.[u.userId] || null,
      characterSheet: db.characterSelections?.[u.userId] || null,
    }))
    .sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));

  users = applyEffectiveAttendance(users, db.events || [], attendanceNameToUserId || {});

  if (hideBots) users = users.filter((u) => !isBotLikeUser(u));

  const summary = buildSummary(users);

  res.json({
    now: new Date().toISOString(),
    meta: db.meta,
    summary,
    users,
    attendanceNameToUserId,
    attendanceMappings,
    todayAttendanceByName,
    characterSelections: db.characterSelections || {},
  });
});

app.get('/api/team/logs', async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 30), 500);
  const hideBots = String(req.query.hideBots || '').toLowerCase() === '1' || String(req.query.hideBots || '').toLowerCase() === 'true';

  if (pgStore.pgEnabled) {
    try {
      const logs = await pgStore.getLogs(limit * 3);
      if (!hideBots) return res.json({ now: new Date().toISOString(), limit, ...logs, rows: logs.rows.slice(0, limit) });

      const status = await pgStore.getDashboardStatus();
      const botIds = new Set((status.users || []).filter((u) => isBotLikeUser(u)).map((u) => String(u.userId)));
      const rows = (logs.rows || []).filter((r) => !botIds.has(String(r.userId))).slice(0, limit);
      return res.json({ now: new Date().toISOString(), limit, totalEvents: rows.length, rows });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  const db = readDb();
  const botIds = new Set((db.users || []).filter((u) => isBotLikeUser(u)).map((u) => String(u.userId)));
  const rows = [...db.events]
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .filter((e) => !hideBots || !botIds.has(String(e.userId)))
    .slice(0, limit)
    .map((e) => ({
      ...e,
      summaryShort: e.summaryShort || e?.raw_payload?.summaryShort || null,
      scheduledFor: e.scheduledFor || e?.raw_payload?.scheduledFor || null,
      durationText: e.durationText || e?.raw_payload?.durationText || null,
    }));

  res.json({ now: new Date().toISOString(), limit, totalEvents: rows.length, rows });
});

app.get('/api/team/leave', async (req, res) => {
  const days = Math.max(1, Math.min(60, Number(req.query.days || 14)));
  const limit = Math.max(1, Math.min(300, Number(req.query.limit || 100)));
  const hideBots = String(req.query.hideBots || '').toLowerCase() === '1' || String(req.query.hideBots || '').toLowerCase() === 'true';
  const leaveStates = new Set(['오전반차', '오후반차', '반차', '휴가', '재택근무']);
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;

  if (pgStore.pgEnabled) {
    try {
      const logs = await pgStore.getLogs(limit * 5);
      let rows = (logs.rows || []).filter((e) => e.kind === 'attendance' && leaveStates.has(e.state || '') && e.at && new Date(e.at).getTime() >= sinceMs);
      if (hideBots) {
        const status = await pgStore.getDashboardStatus();
        const botIds = new Set((status.users || []).filter((u) => isBotLikeUser(u)).map((u) => String(u.userId)));
        rows = rows.filter((r) => !botIds.has(String(r.userId)));
      }
      rows = rows
        .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
        .slice(0, limit)
        .map((e) => ({
          userId: e.userId,
          displayName: e.displayName,
          attendanceName: e.attendanceName || null,
          state: e.state,
          at: e.at,
          scheduledFor: e.scheduledFor || null,
          durationText: e.durationText || null,
          channelId: e.channelId || null,
          messageId: e.messageId || null,
          summary: e.summary || null,
        }));

      return res.json({ now: new Date().toISOString(), days, limit, total: rows.length, rows });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  const db = readDb();
  const botIds = new Set((db.users || []).filter((u) => isBotLikeUser(u)).map((u) => String(u.userId)));
  const rows = [...db.events]
    .filter((e) => e.kind === 'attendance' && leaveStates.has(e.state || '') && e.at)
    .filter((e) => new Date(e.at).getTime() >= sinceMs)
    .filter((e) => !hideBots || !botIds.has(String(e.userId)))
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, limit)
    .map((e) => ({
      userId: e.userId,
      displayName: e.displayName,
      attendanceName: e.attendanceName || null,
      state: e.state,
      at: e.at,
      scheduledFor: e.scheduledFor || null,
      durationText: e.durationText || null,
      channelId: e.channelId || null,
      messageId: e.messageId || null,
      summary: e.summary || null,
    }));

  return res.json({ now: new Date().toISOString(), days, limit, total: rows.length, rows });
});

app.get('/api/team/attendance-unclassified', async (req, res) => {
  const days = Math.max(1, Math.min(60, Number(req.query.days || 14)));
  const limit = Math.max(1, Math.min(300, Number(req.query.limit || 100)));
  const hideBots = String(req.query.hideBots || '').toLowerCase() === '1' || String(req.query.hideBots || '').toLowerCase() === 'true';
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const unclassifiedStates = new Set(['업데이트', 'unknown', '']);

  if (pgStore.pgEnabled) {
    try {
      const logs = await pgStore.getLogs(limit * 5);
      let rows = (logs.rows || []).filter((e) => e.kind === 'attendance' && unclassifiedStates.has(String(e.state || '')) && e.at && new Date(e.at).getTime() >= sinceMs);
      if (hideBots) {
        const status = await pgStore.getDashboardStatus();
        const botIds = new Set((status.users || []).filter((u) => isBotLikeUser(u)).map((u) => String(u.userId)));
        rows = rows.filter((r) => !botIds.has(String(r.userId)));
      }
      rows = rows
        .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
        .slice(0, limit)
        .map((e) => ({
          userId: e.userId,
          displayName: e.displayName,
          attendanceName: e.attendanceName || null,
          state: e.state || '업데이트',
          at: e.at,
          scheduledFor: e.scheduledFor || null,
          durationText: e.durationText || null,
          channelId: e.channelId || null,
          messageId: e.messageId || null,
          summary: e.summary || null,
        }));

      return res.json({ now: new Date().toISOString(), days, limit, total: rows.length, rows });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  const db = readDb();
  const botIds = new Set((db.users || []).filter((u) => isBotLikeUser(u)).map((u) => String(u.userId)));
  const rows = [...db.events]
    .filter((e) => e.kind === 'attendance' && unclassifiedStates.has(String(e.state || '')) && e.at)
    .filter((e) => new Date(e.at).getTime() >= sinceMs)
    .filter((e) => !hideBots || !botIds.has(String(e.userId)))
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, limit)
    .map((e) => ({
      userId: e.userId,
      displayName: e.displayName,
      attendanceName: e.attendanceName || null,
      state: e.state || '업데이트',
      at: e.at,
      scheduledFor: e.scheduledFor || null,
      durationText: e.durationText || null,
      channelId: e.channelId || null,
      messageId: e.messageId || null,
      summary: e.summary || null,
    }));

  return res.json({ now: new Date().toISOString(), days, limit, total: rows.length, rows });
});

app.get('/api/discord/members', (req, res) => {
  res.json({
    now: new Date().toISOString(),
    loadedAt: memberCacheAt,
    total: memberCache.length,
    rows: memberCache,
  });
});

app.get('/api/attendance/names', (req, res) => {
  res.json({
    now: new Date().toISOString(),
    loadedAt: attendanceNameCacheAt,
    lookbackDays: ATTENDANCE_NAME_LOOKBACK_DAYS,
    total: attendanceNameCache.length,
    rows: attendanceNameCache,
  });
});

app.post('/api/attendance/names/refresh', async (req, res) => {
  try {
    await refreshCaches({ includeMembers: false });
    return res.json({ ok: true, loadedAt: attendanceNameCacheAt, total: attendanceNameCache.length });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/attendance/reload-today', async (req, res) => {
  try {
    if (!discordClient?.isReady() || !ATTENDANCE_CHANNEL_IDS.length) {
      return res.status(400).json({ ok: false, error: 'discord client not ready or attendance channels not configured' });
    }

    const now = new Date();
    const offsetMs = 9 * 60 * 60 * 1000;
    const kstNow = new Date(now.getTime() + offsetMs);
    const y = kstNow.getUTCFullYear();
    const m = kstNow.getUTCMonth();
    const d = kstNow.getUTCDate();
    const startUtc = new Date(Date.UTC(y, m, d, 0, 0, 0) - offsetMs);

    let imported = 0;

    if (pgStore.pgEnabled) {
      for (const channelId of ATTENDANCE_CHANNEL_IDS) {
        const ch = await discordClient.channels.fetch(channelId).catch(() => null);
        if (!ch || !ch.isTextBased()) continue;

        let before;
        let done = false;
        while (!done) {
          const batch = await ch.messages.fetch({ limit: 100, before }).catch(() => null);
          if (!batch || batch.size === 0) break;

          const rows = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
          for (const msg of rows) {
            if (msg.createdTimestamp < startUtc.getTime()) {
              done = true;
              continue;
            }

            // 지정 봇 메시지만 처리
            const authorId = msg.author?.id;
            const isWantedSpaceBot = authorId === WANTEDSPACE_BOT_ID;
            const isChronicleBot = authorId === CHRONICLE_BOT_ID;
            if (!isWantedSpaceBot && !isChronicleBot) continue;

            const rawText = getMessageText(msg);
            const state = parseAttendanceState(rawText);
            const scheduleInfo = extractScheduleInfo(rawText);

            // ChronicleBot cancelled
            if (isChronicleBot && state === 'cancelled') {
              const attendanceName = extractAttendanceName(rawText);
              if (attendanceName) {
                await pgStore.insertEvent({ userId: String(msg.author?.id || ''), displayName: msg.member?.displayName || msg.author?.username || attendanceName, kind: 'attendance', state: 'cancelled', attendanceName, summary: rawText, scheduledFor: scheduleInfo.scheduledFor, durationText: scheduleInfo.durationText, channelId, messageId: msg.id, at: msg.createdAt.toISOString() });
                imported += 1;
              }
              continue;
            }

            // 봇별 허용 상태 필터
            const allowed = isWantedSpaceBot ? WANTEDSPACE_STATES.has(state)
                          : isChronicleBot  ? CHRONICLE_SCHEDULE_STATES.has(state)
                          : false;
            if (!allowed) continue;

            const attendanceName = extractAttendanceName(rawText);
            if (!attendanceName) continue;

            const user = {
              userId: String(msg.author?.id || ''),
              displayName: msg.member?.displayName || msg.author?.username || attendanceName,
              attendance: {
                state,
                attendanceName,
                rawText,
                scheduledFor: scheduleInfo.scheduledFor,
                durationText: scheduleInfo.durationText,
                channelId,
                messageId: msg.id,
                at: msg.createdAt.toISOString(),
              },
              work: null,
            };

            await pgStore.upsertUser(user.userId, user.displayName, msg.author?.username || null, msg.author?.globalName || null);
            await pgStore.upsertCurrentStatus(user);
            await pgStore.upsertAttendanceByName(attendanceName, user.attendance);
            await pgStore.insertEvent({
              userId: user.userId,
              displayName: user.displayName,
              kind: 'attendance',
              state,
              attendanceName,
              summary: rawText,
              scheduledFor: scheduleInfo.scheduledFor,
              durationText: scheduleInfo.durationText,
              channelId,
              messageId: msg.id,
              at: msg.createdAt.toISOString(),
            });
            imported += 1;
          }

          before = rows[0]?.id;
          if (!before) break;
        }
      }
      await refreshCaches({ includeMembers: false });
      return res.json({ ok: true, imported, mode: 'postgres' });
    }

    const db = readDb();
    const seenMessageIds = new Set((db.events || []).map((e) => String(e.messageId || '')).filter(Boolean));
    db.attendanceByName ||= {};

    for (const channelId of ATTENDANCE_CHANNEL_IDS) {
      const ch = await discordClient.channels.fetch(channelId).catch(() => null);
      if (!ch || !ch.isTextBased()) continue;

      let before;
      let done = false;
      while (!done) {
        const batch = await ch.messages.fetch({ limit: 100, before }).catch(() => null);
        if (!batch || batch.size === 0) break;

        const rows = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
        for (const msg of rows) {
          if (msg.createdTimestamp < startUtc.getTime()) {
            done = true;
            continue;
          }

          // 지정 봇 메시지만 처리
          const authorId = msg.author?.id;
          const isWantedSpaceBot = authorId === WANTEDSPACE_BOT_ID;
          const isChronicleBot = authorId === CHRONICLE_BOT_ID;
          if (!isWantedSpaceBot && !isChronicleBot) continue;

          const rawText = getMessageText(msg);
          const state = parseAttendanceState(rawText);
          const scheduleInfo = extractScheduleInfo(rawText);

          // ChronicleBot cancelled
          if (isChronicleBot && state === 'cancelled') {
            const attendanceName = extractAttendanceName(rawText);
            if (attendanceName && !seenMessageIds.has(String(msg.id))) {
              const userId = String(msg.author?.id || '');
              const displayName = msg.member?.displayName || msg.author?.username || attendanceName;
              db.events.push({ userId, displayName, kind: 'attendance', state: 'cancelled', attendanceName, summary: rawText, scheduledFor: scheduleInfo.scheduledFor, durationText: scheduleInfo.durationText, channelId, messageId: msg.id, at: msg.createdAt.toISOString() });
              seenMessageIds.add(String(msg.id));
              imported += 1;
            }
            continue;
          }

          // 봇별 허용 상태 필터
          const allowed = isWantedSpaceBot ? WANTEDSPACE_STATES.has(state)
                        : isChronicleBot  ? CHRONICLE_SCHEDULE_STATES.has(state)
                        : false;
          if (!allowed) continue;

          const attendanceName = extractAttendanceName(rawText);
          if (!attendanceName) continue;

          const userId = String(msg.author?.id || '');
          const displayName = msg.member?.displayName || msg.author?.username || attendanceName;
          const at = msg.createdAt.toISOString();

          let user = (db.users || []).find((u) => String(u.userId) === userId);
          if (!user) {
            user = { userId, displayName, isBot: !!msg.author?.bot, attendance: null, work: null, workLogs: [], updatedAt: at };
            db.users.push(user);
          }

          user.displayName = displayName;
          user.isBot = !!msg.author?.bot;
          user.attendance = { state, attendanceName, rawText, scheduledFor: scheduleInfo.scheduledFor, durationText: scheduleInfo.durationText, channelId, messageId: msg.id, at };
          user.updatedAt = at;

          db.attendanceByName[attendanceName] = { state, rawText, scheduledFor: scheduleInfo.scheduledFor, durationText: scheduleInfo.durationText, channelId, messageId: msg.id, at };

          if (!seenMessageIds.has(String(msg.id))) {
            db.events.push({ userId, displayName, kind: 'attendance', state, attendanceName, summary: rawText, scheduledFor: scheduleInfo.scheduledFor, durationText: scheduleInfo.durationText, channelId, messageId: msg.id, at });
            seenMessageIds.add(String(msg.id));
            imported += 1;
          }
        }

        before = rows[0]?.id;
        if (!before) break;
      }
    }

    db.events = (db.events || []).slice(-5000);
    db.meta ||= {};
    db.meta.updatedAt = new Date().toISOString();
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');

    await refreshCaches({ includeMembers: false });
    return res.json({ ok: true, imported, mode: 'json' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// 과거 N일치 근태채널 메시지를 소급 수집 (크로니클봇 스케줄 이벤트 포함)
app.post('/api/attendance/reload-scheduled', async (req, res) => {
  try {
    if (!discordClient?.isReady() || !ATTENDANCE_CHANNEL_IDS.length) {
      return res.status(400).json({ ok: false, error: 'discord client not ready or attendance channels not configured' });
    }

    const days = Math.max(1, Math.min(30, Number(req.body?.days || 7)));
    const startUtc = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    let imported = 0;

    if (pgStore.pgEnabled) {
      for (const channelId of ATTENDANCE_CHANNEL_IDS) {
        const ch = await discordClient.channels.fetch(channelId).catch(() => null);
        if (!ch || !ch.isTextBased()) continue;

        let before;
        let done = false;
        while (!done) {
          const batch = await ch.messages.fetch({ limit: 100, before }).catch(() => null);
          if (!batch || batch.size === 0) break;

          const rows = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
          for (const msg of rows) {
            if (msg.createdTimestamp < startUtc.getTime()) { done = true; continue; }

            // 지정 봇 메시지만 처리
            const authorId = msg.author?.id;
            const isWantedSpaceBot = authorId === WANTEDSPACE_BOT_ID;
            const isChronicleBot = authorId === CHRONICLE_BOT_ID;
            if (!isWantedSpaceBot && !isChronicleBot) continue;

            const rawText = getMessageText(msg);
            const state = parseAttendanceState(rawText);
            const scheduleInfo = extractScheduleInfo(rawText);

            // ChronicleBot cancelled
            if (isChronicleBot && state === 'cancelled') {
              const attendanceName = extractAttendanceName(rawText);
              if (attendanceName) {
                await pgStore.insertEvent({ userId: String(msg.author?.id || ''), displayName: msg.member?.displayName || msg.author?.username || attendanceName, kind: 'attendance', state: 'cancelled', attendanceName, summary: rawText, scheduledFor: scheduleInfo.scheduledFor, durationText: scheduleInfo.durationText, channelId, messageId: msg.id, at: msg.createdAt.toISOString() });
                imported += 1;
              }
              continue;
            }

            // 봇별 허용 상태 필터
            const allowed = isWantedSpaceBot ? WANTEDSPACE_STATES.has(state)
                          : isChronicleBot  ? CHRONICLE_SCHEDULE_STATES.has(state)
                          : false;
            if (!allowed) continue;

            const attendanceName = extractAttendanceName(rawText);
            if (!attendanceName) continue;

            const user = {
              userId: String(msg.author?.id || ''),
              displayName: msg.member?.displayName || msg.author?.username || attendanceName,
              attendance: { state, attendanceName, rawText, scheduledFor: scheduleInfo.scheduledFor, durationText: scheduleInfo.durationText, channelId, messageId: msg.id, at: msg.createdAt.toISOString() },
              work: null,
            };
            await pgStore.upsertUser(user.userId, user.displayName, msg.author?.username || null, msg.author?.globalName || null);
            await pgStore.upsertCurrentStatus(user);
            await pgStore.upsertAttendanceByName(attendanceName, user.attendance);
            await pgStore.insertEvent({ userId: user.userId, displayName: user.displayName, kind: 'attendance', state, attendanceName, summary: rawText, scheduledFor: scheduleInfo.scheduledFor, durationText: scheduleInfo.durationText, channelId, messageId: msg.id, at: msg.createdAt.toISOString() });
            imported += 1;
          }

          before = rows[0]?.id;
          if (!before) break;
        }
      }
      await refreshCaches({ includeMembers: false });
      return res.json({ ok: true, imported, days, mode: 'postgres' });
    }

    const db = readDb();
    const seenMessageIds = new Set((db.events || []).map((e) => String(e.messageId || '')).filter(Boolean));
    db.attendanceByName ||= {};

    for (const channelId of ATTENDANCE_CHANNEL_IDS) {
      const ch = await discordClient.channels.fetch(channelId).catch(() => null);
      if (!ch || !ch.isTextBased()) continue;

      let before;
      let done = false;
      while (!done) {
        const batch = await ch.messages.fetch({ limit: 100, before }).catch(() => null);
        if (!batch || batch.size === 0) break;

        const rows = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
        for (const msg of rows) {
          if (msg.createdTimestamp < startUtc.getTime()) { done = true; continue; }

          // 지정 봇 메시지만 처리
          const authorId = msg.author?.id;
          const isWantedSpaceBot = authorId === WANTEDSPACE_BOT_ID;
          const isChronicleBot = authorId === CHRONICLE_BOT_ID;
          if (!isWantedSpaceBot && !isChronicleBot) continue;

          const rawText = getMessageText(msg);
          const state = parseAttendanceState(rawText);
          const scheduleInfo = extractScheduleInfo(rawText);

          // ChronicleBot cancelled
          if (isChronicleBot && state === 'cancelled') {
            const attendanceName = extractAttendanceName(rawText);
            if (attendanceName && !seenMessageIds.has(String(msg.id))) {
              const userId = String(msg.author?.id || '');
              const displayName = msg.member?.displayName || msg.author?.username || attendanceName;
              db.events.push({ userId, displayName, kind: 'attendance', state: 'cancelled', attendanceName, summary: rawText, scheduledFor: scheduleInfo.scheduledFor, durationText: scheduleInfo.durationText, channelId, messageId: msg.id, at: msg.createdAt.toISOString() });
              seenMessageIds.add(String(msg.id));
              imported += 1;
            }
            continue;
          }

          // 봇별 허용 상태 필터
          const allowed = isWantedSpaceBot ? WANTEDSPACE_STATES.has(state)
                        : isChronicleBot  ? CHRONICLE_SCHEDULE_STATES.has(state)
                        : false;
          if (!allowed) continue;

          const attendanceName = extractAttendanceName(rawText);
          if (!attendanceName) continue;

          const userId = String(msg.author?.id || '');
          const displayName = msg.member?.displayName || msg.author?.username || attendanceName;
          const at = msg.createdAt.toISOString();

          let user = (db.users || []).find((u) => String(u.userId) === userId);
          if (!user) {
            user = { userId, displayName, isBot: !!msg.author?.bot, attendance: null, work: null, workLogs: [], updatedAt: at };
            db.users.push(user);
          }
          user.displayName = displayName;
          user.isBot = !!msg.author?.bot;
          user.attendance = { state, attendanceName, rawText, scheduledFor: scheduleInfo.scheduledFor, durationText: scheduleInfo.durationText, channelId, messageId: msg.id, at };
          user.updatedAt = at;
          db.attendanceByName[attendanceName] = { state, rawText, scheduledFor: scheduleInfo.scheduledFor, durationText: scheduleInfo.durationText, channelId, messageId: msg.id, at };

          if (!seenMessageIds.has(String(msg.id))) {
            db.events.push({ userId, displayName, kind: 'attendance', state, attendanceName, summary: rawText, scheduledFor: scheduleInfo.scheduledFor, durationText: scheduleInfo.durationText, channelId, messageId: msg.id, at });
            seenMessageIds.add(String(msg.id));
            imported += 1;
          }
        }

        before = rows[0]?.id;
        if (!before) break;
      }
    }

    db.events = (db.events || []).slice(-5000);
    db.meta ||= {};
    db.meta.updatedAt = new Date().toISOString();
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
    await refreshCaches({ includeMembers: false });
    return res.json({ ok: true, imported, days, mode: 'json' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/team/mappings/apply', async (req, res) => {
  const mappings = req.body?.mappings;
  if (!mappings || typeof mappings !== 'object') {
    return res.status(400).json({ ok: false, error: 'mappings object is required' });
  }

  const memberById = Object.fromEntries(memberCache.map((m) => [m.userId, m]));

  if (pgStore.pgEnabled) {
    try {
      await pgStore.applyAttendanceMappings(mappings, memberById);
      return res.json({ ok: true, count: Object.keys(mappings).length, updatedAt: new Date().toISOString() });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  const db = readDb();
  const next = {};
  const nextDetail = {};

  for (const [attendanceNameRaw, userIdRaw] of Object.entries(mappings)) {
    const attendanceName = String(attendanceNameRaw || '').trim();
    const userId = String(userIdRaw || '').trim();
    if (!attendanceName) continue;
    if (!/^\d+$/.test(userId)) continue;

    next[attendanceName] = userId;

    const m = memberById[userId];
    nextDetail[attendanceName] = {
      userId,
      displayName: m?.displayName || null,
      username: m?.username || null,
      globalName: m?.globalName || null,
      updatedAt: new Date().toISOString(),
    };
  }

  db.attendanceNameToUserId = next;
  db.attendanceMappings = nextDetail;
  db.meta ||= {};
  db.meta.updatedAt = new Date().toISOString();

  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');

  return res.json({ ok: true, count: Object.keys(next).length, updatedAt: db.meta.updatedAt });
});


app.post('/api/team/characters/apply', async (req, res) => {
  const selections = req.body?.selections;
  if (!selections || typeof selections !== 'object') {
    return res.status(400).json({ ok: false, error: 'selections object is required' });
  }

  if (pgStore.pgEnabled) {
    try {
      await pgStore.applyCharacterSelections(selections);
      return res.json({ ok: true, count: Object.keys(selections).length, updatedAt: new Date().toISOString() });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  const db = readDb();
  const next = {};

  for (const [userIdRaw, sheetRaw] of Object.entries(selections)) {
    const userId = String(userIdRaw || '').trim();
    const sheet = String(sheetRaw || '').trim();
    if (!/^\d+$/.test(userId)) continue;
    if (!sheet) continue;
    next[userId] = sheet;
  }

  db.characterSelections = next;
  db.meta ||= {};
  db.meta.updatedAt = new Date().toISOString();

  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');

  return res.json({ ok: true, count: Object.keys(next).length, updatedAt: db.meta.updatedAt });
});

const CUSTOM_MAP_DIR = path.join(PUBLIC_DIR, 'assets', 'custom-map');
const STATUS_ROOM_MAPPING_FILE = path.join(ROOT_DIR, 'data', 'status-room-mapping.json');

function normalizeMapKey(name = '') {
  const cleaned = String(name || '')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/collision(?:[_-]?mask)?/gi, '')
    .replace(/^[_\-\s]+|[_\-\s]+$/g, '')
    .replace(/[_\s]+/g, '-');
  return cleaned || 'base-map';
}

function listCollisionCatalog() {
  const fallback = [{
    key: 'base-map',
    label: 'base_map',
    baseFile: 'base_map.png',
    collisionFile: 'collision_mask.png',
  }];

  try {
    if (!fs.existsSync(CUSTOM_MAP_DIR)) return fallback;
    const files = fs.readdirSync(CUSTOM_MAP_DIR).filter((f) => /\.png$/i.test(f));
    const bases = files.filter((f) => !/collision/i.test(f));
    const collisions = files.filter((f) => /collision/i.test(f));

    const pairs = new Map();
    for (const baseFile of bases) {
      const key = normalizeMapKey(baseFile);
      pairs.set(key, {
        key,
        label: path.basename(baseFile, path.extname(baseFile)),
        baseFile,
        collisionFile: null,
      });
    }

    for (const collisionFile of collisions) {
      const key = normalizeMapKey(collisionFile);
      const row = pairs.get(key) || {
        key,
        label: path.basename(collisionFile, path.extname(collisionFile)),
        baseFile: null,
        collisionFile: null,
      };
      row.collisionFile = row.collisionFile || collisionFile;
      pairs.set(key, row);
    }

    const out = [...pairs.values()].filter((r) => r.baseFile || r.collisionFile);
    if (out.length === 0) return fallback;
    out.sort((a, b) => a.label.localeCompare(b.label, 'ko'));
    return out;
  } catch {
    return fallback;
  }
}

function resolveCollisionEntry(mapKey) {
  const catalog = listCollisionCatalog();
  const key = normalizeMapKey(mapKey || 'base-map');
  const picked = catalog.find((x) => x.key === key) || catalog[0];
  return { key: picked.key, entry: picked, catalog };
}

function readStatusRoomMapping() {
  try {
    if (!fs.existsSync(STATUS_ROOM_MAPPING_FILE)) return DEFAULT_STATUS_ROOM_MAPPING;
    const raw = JSON.parse(fs.readFileSync(STATUS_ROOM_MAPPING_FILE, 'utf8'));
    return normalizeStatusRoomMapping(raw);
  } catch {
    return DEFAULT_STATUS_ROOM_MAPPING;
  }
}

function writeStatusRoomMapping(payload = {}) {
  const prev = readStatusRoomMapping();
  const next = normalizeStatusRoomMapping({
    ...prev,
    ...payload,
    slotByStatus: {
      ...(prev.slotByStatus || {}),
      ...(payload.slotByStatus || {}),
    },
    updatedAt: new Date().toISOString(),
  });
  fs.mkdirSync(path.dirname(STATUS_ROOM_MAPPING_FILE), { recursive: true });
  fs.writeFileSync(STATUS_ROOM_MAPPING_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function normalizeOverridePayload(payload = {}) {
  const readSet = (value) => {
    const arr = Array.isArray(value) ? value : [];
    const out = [];
    const dedupe = new Set();
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      const x = Number(item.x);
      const y = Number(item.y);
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) continue;
      const key = `${x},${y}`;
      if (dedupe.has(key)) continue;
      dedupe.add(key);
      out.push({ x, y });
    }
    return out;
  };

  const meta = payload && typeof payload.meta === 'object' ? payload.meta : {};
  return {
    version: 1,
    block: readSet(payload?.block),
    clear: readSet(payload?.clear),
    meta: {
      updatedAt: new Date().toISOString(),
      updatedBy: typeof meta.updatedBy === 'string' ? meta.updatedBy : 'dashboard',
      note: typeof meta.note === 'string' ? meta.note : '',
    },
  };
}

function readCollisionOverridesStore() {
  try {
    if (!fs.existsSync(COLLISION_OVERRIDES_FILE)) {
      return { version: 2, maps: {}, meta: { updatedAt: null } };
    }
    const raw = fs.readFileSync(COLLISION_OVERRIDES_FILE, 'utf8');
    const parsed = JSON.parse(raw);

    // Backward compatibility: old shape {block,clear,meta}
    if (Array.isArray(parsed?.block) || Array.isArray(parsed?.clear)) {
      return {
        version: 2,
        maps: { 'base-map': normalizeOverridePayload(parsed) },
        meta: { updatedAt: new Date().toISOString(), migratedFrom: 1 },
      };
    }

    const maps = {};
    for (const [k, v] of Object.entries(parsed?.maps || {})) {
      maps[normalizeMapKey(k)] = normalizeOverridePayload(v);
    }
    return { version: 2, maps, meta: parsed?.meta || { updatedAt: null } };
  } catch {
    return { version: 2, maps: {}, meta: { updatedAt: null } };
  }
}

function readCollisionOverrides(mapKey = 'base-map') {
  const store = readCollisionOverridesStore();
  const key = normalizeMapKey(mapKey);
  return store.maps[key] || {
    version: 1,
    block: [],
    clear: [],
    meta: { updatedAt: null, updatedBy: null, note: '' },
  };
}

function writeCollisionOverrides(mapKey = 'base-map', payload = {}) {
  const key = normalizeMapKey(mapKey);
  const store = readCollisionOverridesStore();
  const normalized = normalizeOverridePayload(payload);
  store.maps[key] = normalized;
  store.meta = { ...(store.meta || {}), updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(COLLISION_OVERRIDES_FILE), { recursive: true });
  fs.writeFileSync(COLLISION_OVERRIDES_FILE, JSON.stringify(store, null, 2), 'utf8');
  return normalized;
}

function readCollisionMaskTiles(mapKey = 'base-map') {
  const { entry } = resolveCollisionEntry(mapKey);
  const collisionPath = entry?.collisionFile ? path.join(CUSTOM_MAP_DIR, entry.collisionFile) : COLLISION_MASK_FILE;
  if (!fs.existsSync(collisionPath)) {
    return { width: 0, height: 0, blocked: [] };
  }
  const buf = fs.readFileSync(collisionPath);
  const png = PNG.sync.read(buf);

  // Each collision tile = 48x48 pixels in the source PNG.
  // Return tile-indexed coordinates so the canvas stays at a sane size.
  const TILE = 48;
  const tilesW = Math.ceil(png.width / TILE);
  const tilesH = Math.ceil(png.height / TILE);
  const blocked = [];

  for (let ty = 0; ty < tilesH; ty += 1) {
    for (let tx = 0; tx < tilesW; tx += 1) {
      // Check if any pixel in this 48x48 block is blocked
      // (a >= 8 && nonBlack r+g+b > 36, matching FE custom map criteria)
      let isBlocked = false;
      outer: for (let dy = 0; dy < TILE && !isBlocked; dy += 1) {
        const py = ty * TILE + dy;
        if (py >= png.height) break;
        for (let dx = 0; dx < TILE; dx += 1) {
          const px = tx * TILE + dx;
          if (px >= png.width) break;
          const idx = (png.width * py + px) << 2;
          const r = png.data[idx];
          const g = png.data[idx + 1];
          const b = png.data[idx + 2];
          const a = png.data[idx + 3];
          if (a >= 8 && (r + g + b) > 36) { isBlocked = true; break outer; }
        }
      }
      if (isBlocked) blocked.push({ x: tx, y: ty });
    }
  }

  return { width: tilesW, height: tilesH, blocked };
}

function buildEffectiveCollision(mask, overrides) {
  const set = new Set((mask.blocked || []).map((p) => `${p.x},${p.y}`));
  for (const p of overrides.clear || []) set.delete(`${p.x},${p.y}`);
  for (const p of overrides.block || []) set.add(`${p.x},${p.y}`);
  const blocked = [...set].map((key) => {
    const [x, y] = key.split(',').map(Number);
    return { x, y };
  });
  return {
    width: mask.width || 0,
    height: mask.height || 0,
    blocked,
  };
}

app.get('/api/map/collision/catalog', (req, res) => {
  const maps = listCollisionCatalog();
  return res.json({ ok: true, maps, layout2x2: maps.slice(0, 4).map((m, i) => ({ slot: i + 1, key: m.key })) });
});

app.get('/api/map/status-room-mapping', (req, res) => {
  return res.json({ ok: true, mapping: readStatusRoomMapping() });
});

app.post('/api/map/status-room-mapping', (req, res) => {
  try {
    const saved = writeStatusRoomMapping(req.body || {});
    return res.json({ ok: true, mapping: saved });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
});

app.get('/api/map/collision/overrides', (req, res) => {
  const mapKey = req.query.mapKey || 'base-map';
  const overrides = readCollisionOverrides(mapKey);
  return res.json({ ok: true, now: new Date().toISOString(), mapKey: normalizeMapKey(mapKey), overrides });
});

app.post('/api/map/collision/overrides', (req, res) => {
  try {
    const mapKey = req.query.mapKey || req.body?.mapKey || 'base-map';
    const saved = writeCollisionOverrides(mapKey, req.body?.overrides || req.body || {});
    return res.json({ ok: true, message: 'collision overrides saved', mapKey: normalizeMapKey(mapKey), overrides: saved });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/map/collision/overrides/reset', (req, res) => {
  try {
    const mapKey = req.query.mapKey || req.body?.mapKey || 'base-map';
    const resetPayload = writeCollisionOverrides(mapKey, { block: [], clear: [], meta: { updatedBy: 'dashboard', note: 'reset' } });
    return res.json({ ok: true, message: 'collision overrides reset', mapKey: normalizeMapKey(mapKey), overrides: resetPayload });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/map/collision/effective', (req, res) => {
  try {
    const mapKey = req.query.mapKey || 'base-map';
    const { entry } = resolveCollisionEntry(mapKey);
    const mask = readCollisionMaskTiles(mapKey);
    const overrides = readCollisionOverrides(mapKey);
    const effective = buildEffectiveCollision(mask, overrides);
    return res.json({
      ok: true,
      now: new Date().toISOString(),
      mapKey: entry?.key,
      map: entry,
      mask: {
        width: mask.width,
        height: mask.height,
        blockedCount: mask.blocked.length,
        blocked: mask.blocked,
      },
      overrides: {
        blockCount: overrides.block.length,
        clearCount: overrides.clear.length,
        meta: overrides.meta,
      },
      effective,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'dashboard.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'dashboard.html'));
});

function isBotLikeUser(u = {}) {
  if (u.isBot === true) return true;
  if (u.userId === WANTEDSPACE_BOT_ID || u.userId === CHRONICLE_BOT_ID) return true;
  const s = `${u.displayName || ''} ${u.username || ''} ${u.globalName || ''}`.toLowerCase();
  return /bot|wantedspacebot|chroniclebot|봇/.test(s);
}

function buildSummary(users = []) {
  const summary = {
    total: users.length,
    attendance: { 출근:0, 퇴근:0, 휴가:0, 오전반차:0, 오후반차:0, 반차:0, 재택근무:0, 자리비움:0, 지각:0, 복귀:0, 안출근:0, 업데이트:0, unknown:0 },
    work: { 진행중:0, 완료:0, 대기:0, 이슈:0, 리뷰중:0, 업데이트:0, unknown:0 },
  };

  for (const u of users) {
    const a = u.attendance?.state || 'unknown';
    const w = u.work?.state || 'unknown';
    summary.attendance[a] = (summary.attendance[a] || 0) + 1;
    summary.work[w] = (summary.work[w] || 0) + 1;
  }
  return summary;
}

function kstDateKey(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const day = String(kst.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function applyEffectiveAttendance(users = [], events = [], attendanceNameToUserId = {}) {
  const todayKey = kstDateKey(new Date().toISOString());
  const byUser = new Map();

  for (const e of events || []) {
    if (e.kind !== 'attendance') continue;
    const directUserId = String(e.userId || '');
    const mappedUserId = attendanceNameToUserId?.[e.attendanceName || ''] || null;
    // bot 메시지(wantedspaceBotV2, ChronicleBot)는 attendanceName → userId 매핑 사용
    const isBotProxy = directUserId === WANTEDSPACE_BOT_ID || directUserId === CHRONICLE_BOT_ID;
    const userId = (!isBotProxy && directUserId) ? directUserId : mappedUserId;
    if (!userId) continue;

    const row = byUser.get(userId) || {
      hasCheckIn: false,
      hasCheckOut: false,
      scheduledState: null,
      scheduledAt: null,
      hasRemoteSchedule: false,
      lastEventAt: null,
    };
    const atKey = kstDateKey(e.at);
    if (atKey === todayKey) {
      if (e.state === '출근') row.hasCheckIn = true;
      if (e.state === '퇴근') row.hasCheckOut = true;
    }

    // 가장 최근 이벤트 시간 추적 (bot 프록시 사용자도 타임스탬프 표시용)
    if (e.at && new Date(e.at).getTime() > new Date(row.lastEventAt || 0).getTime()) {
      row.lastEventAt = e.at;
    }

    const schedKey = kstDateKey(e.scheduledFor);
    const LEAVE_STATES = ['휴가', '오전반차', '오후반차', '반차'];
    // scheduledFor가 오늘이거나, scheduledFor 없이 당일 올린 공지도 오늘 일정으로 처리
    const isScheduledForToday = schedKey === todayKey
      || (!schedKey && atKey === todayKey && [...LEAVE_STATES, '재택근무', 'cancelled'].includes(String(e.state || '')));

    // cancelled: 해당 날짜 스케줄 초기화 (이벤트 시간순 처리되므로 취소가 원본 이후에 오면 정확)
    if (isScheduledForToday && e.state === 'cancelled') {
      row.hasRemoteSchedule = false;
      row.scheduledState = null;
      row.scheduledAt = null;
    }

    // 재택근무 일정은 별도 플래그로 추적 (출근 이벤트와 조합해서 판정)
    if (isScheduledForToday && e.state === '재택근무') {
      row.hasRemoteSchedule = true;
    }
    // 휴가/반차 계열은 scheduledState로 추적 (최신 이벤트 우선)
    if (isScheduledForToday && LEAVE_STATES.includes(String(e.state || ''))) {
      const ts = new Date(e.at || 0).getTime();
      const prevTs = new Date(row.scheduledAt || 0).getTime();
      if (!row.scheduledAt || ts >= prevTs) {
        row.scheduledState = e.state;
        row.scheduledAt = e.at;
      }
    }

    byUser.set(userId, row);
  }

  return users.map((u) => {
    const facts = byUser.get(String(u.userId)) || {
      hasCheckIn: false,
      hasCheckOut: false,
      scheduledState: null,
      hasRemoteSchedule: false,
    };
    const { scheduledState: scheduled, hasCheckIn, hasCheckOut, hasRemoteSchedule } = facts;
    let effective;

    if (scheduled === '휴가') {
      // 연차/휴가: 스케줄 우선 → 출근 기록이 있어도 휴가
      effective = '휴가';
    } else if (scheduled === '오전반차' || scheduled === '반차') {
      // 오전반차/반차: 스케줄 우선 → 휴가
      effective = '휴가';
    } else if (scheduled === '오후반차') {
      // 오후반차: 퇴근 이벤트 있으면 휴가, 출근 이벤트 있으면 출근 유지, 둘 다 없으면 안출근
      if (hasCheckOut) effective = '휴가';
      else if (hasCheckIn) effective = hasRemoteSchedule ? '재택근무' : '출근';
      else effective = '안출근';
    } else if (hasCheckOut) {
      // 퇴근 이벤트: 안출근으로 처리
      effective = '안출근';
    } else if (hasCheckIn) {
      // 출근 이벤트: 재택 일정 있으면 재택근무, 없으면 출근(사무실)
      effective = hasRemoteSchedule ? '재택근무' : '출근';
    } else {
      effective = '안출근';
    }

    return {
      ...u,
      attendance: {
        ...(u.attendance || {}),
        scheduledState: scheduled || null,
        state: effective,
        // bot 프록시 경유 사용자도 날짜 표시 가능하도록 최근 이벤트 시간으로 보완
        at: (u.attendance?.at) || facts.lastEventAt || u.updatedAt || null,
      },
    };
  });
}

function getTodayKstAttendanceByName(db) {
  const now = new Date();
  const offsetMs = 9 * 60 * 60 * 1000;
  const kstNow = new Date(now.getTime() + offsetMs);
  const y = kstNow.getUTCFullYear();
  const m = kstNow.getUTCMonth();
  const d = kstNow.getUTCDate();
  const startUtc = new Date(Date.UTC(y, m, d, 0, 0, 0) - offsetMs);
  const endUtc = new Date(Date.UTC(y, m, d + 1, 0, 0, 0) - offsetMs);

  const out = {};
  const rows = [...(db.events || [])]
    .filter((e) => e.kind === 'attendance' && e.at)
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  for (const e of rows) {
    const ts = new Date(e.at).getTime();
    if (ts < startUtc.getTime() || ts >= endUtc.getTime()) continue;
    const name = e.attendanceName || extractAttendanceName(e.summary || e.rawText || '');
    if (!name) continue;
    out[name] = {
      state: e.state || '업데이트',
      at: e.at,
      rawText: e.summary || e.rawText || '',
      messageId: e.messageId || null,
      channelId: e.channelId || null,
    };
  }

  return out;
}

function parseAttendanceState(text) {
  const t = String(text || '').trim();
  if (!t) return '업데이트';
  if (/cancelled|취소됨/i.test(t)) return 'cancelled';
  if (/출근/.test(t)) return '출근';
  if (/퇴근/.test(t)) return '퇴근';
  if (/지각/.test(t)) return '지각';
  if (/복귀/.test(t)) return '복귀';
  if (/재택/.test(t)) return '재택근무';
  if (/오전\s*반차|am\s*half/.test(t)) return '오전반차';
  if (/오후\s*반차|pm\s*half/.test(t)) return '오후반차';
  if (/반차/.test(t)) return '반차';
  if (/연차|휴가/.test(t)) return '휴가';
  if (/외근|자리비움/.test(t)) return '자리비움';
  return '업데이트';
}

function extractScheduleInfo(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return { scheduledFor: null, durationText: null };

  const dateMatch = t.match(/Scheduled\s*for\s*([^\n]+?)(?:\s+Duration\b|$)/i);
  const durationMatch = t.match(/Duration\s*([^\n]+)$/i);

  const dateRaw = (dateMatch?.[1] || '').replace(/\s+/g, ' ').trim();
  const durationText = (durationMatch?.[1] || '').replace(/\s+/g, ' ').trim() || null;

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

function getMessageText(msg) {
  const chunks = [];
  if (msg?.content) chunks.push(msg.content);
  for (const e of msg?.embeds || []) {
    if (e.title) chunks.push(e.title);
    if (e.description) chunks.push(e.description);
    for (const f of e.fields || []) {
      if (f?.name) chunks.push(f.name);
      if (f?.value) chunks.push(f.value);
    }
  }
  return chunks.join(' ');
}

function extractAttendanceName(text) {
  const t = String(text || '').trim();
  if (!t) return null;

  const cleaned = t.replace(/[*_`~\[\]]/g, ' ').replace(/\s+/g, ' ').trim();

  const patterns = [
    /^\d{1,2}월\s*\d{1,2}일(?:\([^)]*\))?\s+([가-힣A-Za-z]{2,12}).*(?:출근|퇴근)\s*했습니다\.?/,
    /^([가-힣A-Za-z]{2,12})\s+(?:재택근무|연차|반차|휴가)\b/,
    /([가-힣A-Za-z]{2,12})\s+(?:재택근무|연차|반차|휴가)\b/,
    /^\[\s*([^\]]{2,20})\s*\]/,
    /^([가-힣A-Za-z][가-힣A-Za-z0-9._ -]{1,19})\s*[:：\-]\s*(출근|퇴근|휴가|지각|외근|복귀|반차|연차|재택근무)/,
    /(?:이름|성명)\s*[:：]\s*([가-힣A-Za-z][가-힣A-Za-z0-9._ -]{1,19})/,
    /^([가-힣]{2,4})\s+(?:출근|퇴근|휴가|지각|외근|복귀|반차|연차|재택근무)/,
    /([가-힣A-Za-z]{2,12})\s*(?:님)?\s*(?:출근|퇴근|휴가|지각|외근|복귀|반차|연차|재택근무)/,
  ];

  for (const p of patterns) {
    const m = cleaned.match(p);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

app.listen(PORT, async () => {
  console.log(`[DASHBOARD] http://localhost:${PORT}/dashboard`);
  console.log(`[DASHBOARD] API status: http://localhost:${PORT}/api/team/status`);
  await initDiscordMemberCache();
});
