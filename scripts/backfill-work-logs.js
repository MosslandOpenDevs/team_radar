require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { JSONFileSync } = require('lowdb/node');
const { LowSync } = require('lowdb');
const { Client, GatewayIntentBits } = require('discord.js');

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const WORK_CHANNEL_IDS = parseIds(process.env.WORK_CHANNEL_IDS);
const MAX_WORK_LOGS_PER_USER = Number(process.env.MAX_WORK_LOGS_PER_USER || 20);
const BACKFILL_DAYS = Number(process.env.BACKFILL_DAYS || 3);
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'team-status-db.json');

if (!BOT_TOKEN) {
  console.error('[ERROR] DISCORD_BOT_TOKEN is required');
  process.exit(1);
}
if (!WORK_CHANNEL_IDS.length) {
  console.error('[ERROR] WORK_CHANNEL_IDS is required');
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const adapter = new JSONFileSync(DB_FILE);
const db = new LowSync(adapter, { users: [], events: [], meta: {} });
db.read();
db.data ||= { users: [], events: [], meta: {} };
db.data.users ||= [];
db.data.events ||= [];

const sinceMs = Date.now() - BACKFILL_DAYS * 24 * 60 * 60 * 1000;
const sinceDate = new Date(sinceMs);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once('ready', async () => {
  console.log(`[BACKFILL] Logged in as ${client.user.tag}`);
  console.log(`[BACKFILL] since=${sinceDate.toISOString()}, channels=${WORK_CHANNEL_IDS.join(',')}`);

  let importedCount = 0;

  for (const channelId of WORK_CHANNEL_IDS) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      console.warn(`[WARN] skip channel ${channelId} (not accessible or text channel)`);
      continue;
    }

    let before;
    let stop = false;

    while (!stop) {
      const batch = await channel.messages.fetch({ limit: 100, before }).catch((e) => {
        console.warn(`[WARN] fetch failed for ${channelId}: ${e.message}`);
        return null;
      });

      if (!batch || batch.size === 0) break;

      const rows = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

      for (const msg of rows) {
        if (msg.author?.bot) continue;
        if (msg.createdTimestamp < sinceMs) {
          stop = true;
          continue;
        }

        if (db.data.events.some((e) => e.messageId === msg.id)) {
          continue; // already imported
        }

        const userId = msg.author.id;
        const displayName = msg.member?.displayName || msg.author.globalName || msg.author.username;
        const summary = compact(msg.content || '(첨부/임베드 메시지)');
        const state = parseWorkState(summary);
        const at = msg.createdAt.toISOString();

        const user = getOrCreateUser(userId, displayName);
        user.displayName = displayName;
        user.work = {
          state,
          summary,
          channelId: msg.channelId,
          messageId: msg.id,
          at,
        };
        user.workLogs ||= [];
        user.workLogs.unshift({
          state,
          summary,
          channelId: msg.channelId,
          messageId: msg.id,
          at,
        });
        user.workLogs = dedupeByMessageId(user.workLogs).slice(0, MAX_WORK_LOGS_PER_USER);
        user.updatedAt = new Date().toISOString();

        db.data.events.push({
          userId,
          displayName,
          kind: 'work',
          state,
          summary,
          channelId: msg.channelId,
          messageId: msg.id,
          at,
        });

        importedCount += 1;
      }

      const last = rows[0];
      before = last?.id;
      if (!before) break;
    }
  }

  db.data.events = dedupeByMessageId(db.data.events)
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
    .slice(-5000);

  db.data.meta ||= {};
  db.data.meta.updatedAt = new Date().toISOString();
  db.data.meta.lastBackfillAt = new Date().toISOString();
  db.data.meta.lastBackfillDays = BACKFILL_DAYS;

  db.write();

  console.log(`[BACKFILL] done. imported=${importedCount}, users=${db.data.users.length}, events=${db.data.events.length}`);
  await client.destroy();
  process.exit(0);
});

client.login(BOT_TOKEN);

function parseIds(raw) {
  return String(raw || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function getOrCreateUser(userId, displayName) {
  let row = db.data.users.find((u) => u.userId === userId);
  if (!row) {
    row = {
      userId,
      displayName,
      attendance: null,
      work: null,
      workLogs: [],
      updatedAt: new Date().toISOString(),
    };
    db.data.users.push(row);
  }
  return row;
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

function compact(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function dedupeByMessageId(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (!r?.messageId || seen.has(r.messageId)) continue;
    seen.add(r.messageId);
    out.push(r);
  }
  return out;
}
