require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const { PNG } = require('pngjs');
const { Client, GatewayIntentBits } = require('discord.js');
const { ROOT_DIR, DB_FILE, COLLISION_OVERRIDES_FILE, COLLISION_MASK_FILE } = require('../../core/paths');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const pgStore = require('../../core/pg-store');
const {
  DEFAULT_STATUS_ROOM_MAPPING,
  normalizeStatusRoomMapping,
} = require('../../shared/status-zones');

const PORT = Number(process.env.DASHBOARD_PORT || 3100);
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;
const ATTENDANCE_CHANNEL_IDS = String(process.env.ATTENDANCE_CHANNEL_IDS || '')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);
const ATTENDANCE_NAME_LOOKBACK_DAYS = Math.max(1, Number(process.env.ATTENDANCE_NAME_LOOKBACK_DAYS || 5));

const app = express();
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json());
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
      const users = hideBots ? (status.users || []).filter((u) => !isBotLikeUser(u)) : (status.users || []);
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
    .slice(0, limit);

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
            const rawText = getMessageText(msg);
            const state = parseAttendanceState(rawText);
            const attendanceName = extractAttendanceName(rawText);
            if (!attendanceName) continue;

            const user = {
              userId: String(msg.author?.id || ''),
              displayName: msg.member?.displayName || msg.author?.username || attendanceName,
              attendance: {
                state,
                attendanceName,
                rawText,
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

          const rawText = getMessageText(msg);
          const state = parseAttendanceState(rawText);
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
          user.attendance = { state, attendanceName, rawText, channelId, messageId: msg.id, at };
          user.updatedAt = at;

          db.attendanceByName[attendanceName] = { state, rawText, channelId, messageId: msg.id, at };

          if (!seenMessageIds.has(String(msg.id))) {
            db.events.push({ userId, displayName, kind: 'attendance', state, attendanceName, summary: rawText, channelId, messageId: msg.id, at });
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
  const blocked = [];
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const idx = (png.width * y + x) << 2;
      const r = png.data[idx];
      const g = png.data[idx + 1];
      const b = png.data[idx + 2];
      const a = png.data[idx + 3];
      if (a > 0 && (r + g + b) < 700) blocked.push({ x, y });
    }
  }
  return { width: png.width, height: png.height, blocked };
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
  const s = `${u.displayName || ''} ${u.username || ''} ${u.globalName || ''}`.toLowerCase();
  return /bot|wantedspacebot|chroniclebot|봇/.test(s);
}

function buildSummary(users = []) {
  const summary = {
    total: users.length,
    attendance: { 출근:0, 퇴근:0, 휴가:0, 오전반차:0, 오후반차:0, 반차:0, 재택근무:0, 자리비움:0, 지각:0, 복귀:0, 업데이트:0, unknown:0 },
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

  const patterns = [
    /^\d{1,2}월\s*\d{1,2}일(?:\([^)]*\))?\s+([가-힣A-Za-z]{2,12}).*(?:출근|퇴근)\s*했습니다\.?/,
    /^([가-힣A-Za-z]{2,12})\s+(?:재택근무|연차|반차|휴가)\b/,
    /^\[\s*([^\]]{2,20})\s*\]/,
    /^([가-힣A-Za-z][가-힣A-Za-z0-9._ -]{1,19})\s*[:：\-]\s*(출근|퇴근|휴가|지각|외근|복귀|반차|연차)/,
    /(?:이름|성명)\s*[:：]\s*([가-힣A-Za-z][가-힣A-Za-z0-9._ -]{1,19})/,
    /^([가-힣]{2,4})\s+(?:출근|퇴근|휴가|지각|외근|복귀|반차|연차)/,
    /([가-힣A-Za-z]{2,12})\s*(?:님)?\s*(?:출근|퇴근|휴가|지각|외근|복귀|반차|연차)/,
  ];

  for (const p of patterns) {
    const m = t.match(p);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

app.listen(PORT, async () => {
  console.log(`[DASHBOARD] http://localhost:${PORT}/dashboard`);
  console.log(`[DASHBOARD] API status: http://localhost:${PORT}/api/team/status`);
  await initDiscordMemberCache();
});
