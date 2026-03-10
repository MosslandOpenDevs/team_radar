require('dotenv').config();
const fs = require('fs');
const { JSONFileSync } = require('lowdb/node');
const { LowSync } = require('lowdb');
const { ROOT_DIR, DATA_DIR, DB_FILE } = require('../../core/paths');
const pgStore = require('../../core/pg-store');
const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
} = require('discord.js');

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const ATTENDANCE_CHANNEL_IDS = parseIds(process.env.ATTENDANCE_CHANNEL_IDS);
const WORK_CHANNEL_IDS = parseIds(process.env.WORK_CHANNEL_IDS);
const COMMAND_CHANNEL_IDS = parseIds(process.env.COMMAND_CHANNEL_IDS || '');
const MAX_WORK_LOGS_PER_USER = Number(process.env.MAX_WORK_LOGS_PER_USER || 20);
const STARTUP_ATTENDANCE_BACKFILL = String(process.env.STARTUP_ATTENDANCE_BACKFILL || 'true').toLowerCase() !== 'false';
const ATTENDANCE_BACKFILL_DAYS_KST = Math.max(1, Number(process.env.ATTENDANCE_BACKFILL_DAYS_KST || 1));
const STARTUP_WORK_BACKFILL = String(process.env.STARTUP_WORK_BACKFILL || 'true').toLowerCase() !== 'false';
const WORK_BACKFILL_DAYS = Math.max(1, Number(process.env.WORK_BACKFILL_DAYS || 7));

// 근태 채널에서 처리할 봇 ID 및 허용 상태
const WANTEDSPACE_BOT_ID = process.env.WANTEDSPACE_BOT_ID || ''; // wantedspaceBotV2 - 출근/퇴근
const CHRONICLE_BOT_ID = process.env.CHRONICLE_BOT_ID || '';      // ChronicleBot - 연차/반차/재택근무
const WANTEDSPACE_STATES = new Set(['출근', '퇴근', '지각', '복귀', '자리비움']);
const CHRONICLE_SCHEDULE_STATES = new Set(['재택근무', '연차', '반차', '오전반차', '오후반차', '휴가']);


if (!BOT_TOKEN) {
  console.error('[ERROR] DISCORD_BOT_TOKEN is required in .env');
  process.exit(1);
}

if (!ATTENDANCE_CHANNEL_IDS.length && !WORK_CHANNEL_IDS.length) {
  console.error('[ERROR] Set at least one of ATTENDANCE_CHANNEL_IDS or WORK_CHANNEL_IDS in .env');
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });

const adapter = new JSONFileSync(DB_FILE);
const db = new LowSync(adapter, {
  users: [],
  events: [],
  nameMappings: {},
  attendanceByName: {},
  meta: {
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
});

db.read();
db.data ||= { users: [], events: [], nameMappings: {}, attendanceByName: {}, meta: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } };
db.data.nameMappings ||= {};
db.data.attendanceByName ||= {};

const monitoredChannelSet = new Set([...ATTENDANCE_CHANNEL_IDS, ...WORK_CHANNEL_IDS]);
const attendanceSet = new Set(ATTENDANCE_CHANNEL_IDS);
const workSet = new Set(WORK_CHANNEL_IDS);
const commandSet = new Set(COMMAND_CHANNEL_IDS);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

client.once(Events.ClientReady, async (c) => {
  console.log(`[READY] Logged in as ${c.user.tag}`);
  console.log(`[READY] Monitoring attendance channels: ${ATTENDANCE_CHANNEL_IDS.join(', ') || '(none)'}`);
  console.log(`[READY] Monitoring work channels: ${WORK_CHANNEL_IDS.join(', ') || '(none)'}`);
  console.log(`[READY] DB file: ${DB_FILE}`);
  if (pgStore.pgEnabled) console.log(`[READY] PostgreSQL mirror enabled (mode=${pgStore.MODE})`);

  if (STARTUP_ATTENDANCE_BACKFILL) {
    const { startUtc, endUtc } = getRecentKstDayWindow(ATTENDANCE_BACKFILL_DAYS_KST);
    const imported = await startupBackfillAttendance(client, startUtc, endUtc);
    if (imported > 0) {
      touchMeta(new Date().toISOString());
      db.write();
    }
    console.log(`[BOOT] attendance backfill imported=${imported} (KST ${ATTENDANCE_BACKFILL_DAYS_KST} day)`);
  }

  if (STARTUP_WORK_BACKFILL) {
    const { startUtc, endUtc } = getRecentUtcWindowByDays(WORK_BACKFILL_DAYS);
    const imported = await startupBackfillWork(client, startUtc, endUtc);
    if (imported > 0) {
      touchMeta(new Date().toISOString());
      db.write();
    }
    console.log(`[BOOT] work backfill imported=${imported} (${WORK_BACKFILL_DAYS} day)`);
  }
});

client.on(Events.MessageCreate, async (message) => {
  const isAttendanceChannel = attendanceSet.has(message.channelId);

  // 근태 채널: wantedspaceBotV2 / ChronicleBot 만 처리, 그 외 전부 무시
  if (isAttendanceChannel) {
    const aid = message.author.id;
    if (aid !== WANTEDSPACE_BOT_ID && aid !== CHRONICLE_BOT_ID) return;
  } else {
    // 업무 채널: 봇 메시지 무시
    if (message.author.bot) return;
  }

  if (shouldHandleCommand(message)) {
    await handleCommand(message);
    return;
  }

  if (!monitoredChannelSet.has(message.channelId)) return;

  const userId = message.author.id;
  const displayName = message.member?.displayName || message.author.username;
  const nowIso = new Date().toISOString();

  const user = getOrCreateUser(userId, displayName);
  user.displayName = displayName;
  user.isBot = !!message.author?.bot;

  if (isAttendanceChannel) {
    const authorId = message.author.id;
    const isChronicleBot = authorId === CHRONICLE_BOT_ID;
    const isWantedSpaceBot = authorId === WANTEDSPACE_BOT_ID;

    const rawText = getAttendanceSourceText(message);
    const state = parseAttendanceState(rawText);
    const scheduleInfo = extractScheduleInfo(rawText);

    // ChronicleBot cancelled: 스케줄 취소 이벤트 저장 후 캐시 제거
    if (isChronicleBot && state === 'cancelled') {
      const attendanceName = extractAttendanceName(rawText);
      if (attendanceName) {
        const eventRow = {
          userId, displayName, kind: 'attendance', state: 'cancelled',
          attendanceName, summary: rawText,
          scheduledFor: scheduleInfo.scheduledFor, durationText: scheduleInfo.durationText,
          channelId: message.channelId, messageId: message.id,
          at: message.createdAt.toISOString(),
        };
        appendEvent(eventRow);
        delete db.data.attendanceByName[attendanceName];
        if (pgStore.pgEnabled) {
          try { await pgStore.insertEvent(eventRow); } catch (err) { console.warn('[CANCEL]', err.message); }
        }
        touchMeta(nowIso);
        db.write();
      }
      return;
    }

    // 봇별 허용 상태 필터
    const allowed = isWantedSpaceBot ? WANTEDSPACE_STATES.has(state)
                  : isChronicleBot  ? CHRONICLE_SCHEDULE_STATES.has(state)
                  : false;
    if (!allowed) return;

    const attendanceName = extractAttendanceName(rawText);

    user.attendance = {
      state,
      attendanceName,
      rawText,
      scheduledFor: scheduleInfo.scheduledFor,
      durationText: scheduleInfo.durationText,
      channelId: message.channelId,
      messageId: message.id,
      at: message.createdAt.toISOString(),
    };

    if (attendanceName) {
      db.data.attendanceByName[attendanceName] = {
        state,
        rawText,
        scheduledFor: scheduleInfo.scheduledFor,
        durationText: scheduleInfo.durationText,
        channelId: message.channelId,
        messageId: message.id,
        at: message.createdAt.toISOString(),
      };
    }

    const eventRow = {
      userId,
      displayName,
      kind: 'attendance',
      state,
      attendanceName,
      summary: rawText,
      scheduledFor: scheduleInfo.scheduledFor,
      durationText: scheduleInfo.durationText,
      channelId: message.channelId,
      messageId: message.id,
      at: message.createdAt.toISOString(),
    };
    appendEvent(eventRow);

    if (pgStore.pgEnabled) {
      await mirrorPostgres(user, eventRow, attendanceName ? db.data.attendanceByName[attendanceName] : null);
    }
  }

  if (workSet.has(message.channelId)) {
    const state = parseWorkState(message.content);
    const summary = compact(message.content);

    user.work = {
      state,
      summary,
      channelId: message.channelId,
      messageId: message.id,
      at: message.createdAt.toISOString(),
    };

    user.workLogs ||= [];
    user.workLogs.unshift({
      state,
      summary,
      channelId: message.channelId,
      messageId: message.id,
      at: message.createdAt.toISOString(),
    });
    user.workLogs = user.workLogs.slice(0, MAX_WORK_LOGS_PER_USER);

    const eventRow = {
      userId,
      displayName,
      kind: 'work',
      state,
      summary,
      channelId: message.channelId,
      messageId: message.id,
      at: message.createdAt.toISOString(),
    };
    appendEvent(eventRow);

    if (pgStore.pgEnabled) {
      await mirrorPostgres(user, eventRow, null);
      await pgStore.insertWorkLog(userId, {
        state,
        summary,
        channelId: message.channelId,
        messageId: message.id,
        at: message.createdAt.toISOString(),
      });
    }
  }

  user.updatedAt = nowIso;
  touchMeta(nowIso);
  db.write();

  console.log(`[TRACK] ${displayName} in #${message.channelId} updated`);
});

client.login(BOT_TOKEN);

async function startupBackfillAttendance(client, startUtc, endUtc) {
  let imported = 0;

  for (const channelId of ATTENDANCE_CHANNEL_IDS) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      console.warn(`[BOOT] skip attendance channel ${channelId}`);
      continue;
    }

    let before;
    let stop = false;

    while (!stop) {
      const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
      if (!batch || batch.size === 0) break;

      const rows = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

      for (const msg of rows) {
        if (msg.createdTimestamp < startUtc.getTime()) {
          stop = true;
          continue;
        }
        if (msg.createdTimestamp >= endUtc.getTime()) continue;

        // 근태 채널: 지정 봇 메시지만 처리
        const authorId = msg.author.id;
        const isWantedSpaceBot = authorId === WANTEDSPACE_BOT_ID;
        const isChronicleBot = authorId === CHRONICLE_BOT_ID;
        if (!isWantedSpaceBot && !isChronicleBot) continue;

        const userId = msg.author.id;
        const displayName = msg.member?.displayName || msg.author.globalName || msg.author.username;
        const rawText = getAttendanceSourceText(msg);
        const state = parseAttendanceState(rawText);
        const scheduleInfo = extractScheduleInfo(rawText);

        // ChronicleBot cancelled
        if (isChronicleBot && state === 'cancelled') {
          const attendanceName = extractAttendanceName(rawText);
          if (attendanceName && !db.data.events.some((e) => e.messageId === msg.id)) {
            db.data.events.push({
              userId, displayName, kind: 'attendance', state: 'cancelled',
              attendanceName, summary: rawText,
              scheduledFor: scheduleInfo.scheduledFor, durationText: scheduleInfo.durationText,
              channelId: msg.channelId, messageId: msg.id, at: msg.createdAt.toISOString(),
            });
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

        const user = getOrCreateUser(userId, displayName);
        user.displayName = displayName;
        user.isBot = !!msg.author?.bot;
        user.attendance = {
          state,
          attendanceName,
          rawText,
          scheduledFor: scheduleInfo.scheduledFor,
          durationText: scheduleInfo.durationText,
          channelId: msg.channelId,
          messageId: msg.id,
          at: msg.createdAt.toISOString(),
        };
        if (attendanceName) {
          db.data.attendanceByName[attendanceName] = {
            state,
            rawText,
            scheduledFor: scheduleInfo.scheduledFor,
            durationText: scheduleInfo.durationText,
            channelId: msg.channelId,
            messageId: msg.id,
            at: msg.createdAt.toISOString(),
          };
        }
        user.updatedAt = new Date().toISOString();

        if (!db.data.events.some((e) => e.messageId === msg.id)) {
          db.data.events.push({
            userId,
            displayName,
            kind: 'attendance',
            state,
            attendanceName,
            summary: rawText,
            scheduledFor: scheduleInfo.scheduledFor,
            durationText: scheduleInfo.durationText,
            channelId: msg.channelId,
            messageId: msg.id,
            at: msg.createdAt.toISOString(),
          });
          imported += 1;
        }
      }

      before = rows[0]?.id;
      if (!before) break;
    }
  }

  if (db.data.events.length > 5000) {
    db.data.events = db.data.events.slice(-5000);
  }

  return imported;
}

async function startupBackfillWork(client, startUtc, endUtc) {
  let imported = 0;

  for (const channelId of WORK_CHANNEL_IDS) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      console.warn(`[BOOT] skip work channel ${channelId}`);
      continue;
    }

    let before;
    let stop = false;

    while (!stop) {
      const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
      if (!batch || batch.size === 0) break;

      const rows = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

      for (const msg of rows) {
        if (msg.createdTimestamp < startUtc.getTime()) {
          stop = true;
          continue;
        }
        if (msg.createdTimestamp >= endUtc.getTime()) continue;
        if (msg.author?.bot) continue;

        const userId = msg.author.id;
        const displayName = msg.member?.displayName || msg.author.globalName || msg.author.username;
        const summary = compact(msg.content || '');
        const state = parseWorkState(summary);

        const user = getOrCreateUser(userId, displayName);
        user.displayName = displayName;
        user.isBot = !!msg.author?.bot;
        user.work = {
          state,
          summary,
          channelId: msg.channelId,
          messageId: msg.id,
          at: msg.createdAt.toISOString(),
        };
        user.workLogs ||= [];
        user.workLogs.unshift({
          state,
          summary,
          channelId: msg.channelId,
          messageId: msg.id,
          at: msg.createdAt.toISOString(),
        });
        user.workLogs = user.workLogs.slice(0, MAX_WORK_LOGS_PER_USER);
        user.updatedAt = new Date().toISOString();

        if (!db.data.events.some((e) => e.messageId === msg.id)) {
          db.data.events.push({
            userId,
            displayName,
            kind: 'work',
            state,
            summary,
            channelId: msg.channelId,
            messageId: msg.id,
            at: msg.createdAt.toISOString(),
          });
          imported += 1;
        }
      }

      before = rows[0]?.id;
      if (!before) break;
    }
  }

  if (db.data.events.length > 5000) {
    db.data.events = db.data.events.slice(-5000);
  }

  return imported;
}

function getRecentKstDayWindow(days) {
  const now = new Date();
  const offsetMs = 9 * 60 * 60 * 1000;
  const kstNow = new Date(now.getTime() + offsetMs);

  const y = kstNow.getUTCFullYear();
  const m = kstNow.getUTCMonth();
  const d = kstNow.getUTCDate();

  const endUtcMs = Date.UTC(y, m, d + 1, 0, 0, 0) - offsetMs;
  const startUtcMs = endUtcMs - days * 24 * 60 * 60 * 1000;

  return {
    startUtc: new Date(startUtcMs),
    endUtc: new Date(endUtcMs),
  };
}

function getRecentUtcWindowByDays(days) {
  const endUtc = new Date();
  const startUtc = new Date(endUtc.getTime() - days * 24 * 60 * 60 * 1000);
  return { startUtc, endUtc };
}

function parseIds(raw) {
  return String(raw || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function shouldHandleCommand(message) {
  const isCmd =
    message.content.startsWith('!teamstatus') ||
    message.content.startsWith('!teamlogs') ||
    message.content.startsWith('!teamleave') ||
    message.content.startsWith('!mapname') ||
    message.content.startsWith('!unmapname') ||
    message.content.startsWith('!namemap');

  if (!isCmd) return false;
  if (!commandSet.size) return true;
  return commandSet.has(message.channelId);
}

async function handleCommand(message) {
  if (message.content.startsWith('!teamlogs')) {
    await handleLogsCommand(message);
    return;
  }

  if (message.content.startsWith('!teamleave')) {
    await handleLeaveCommand(message);
    return;
  }

  if (message.content.startsWith('!mapname')) {
    await handleMapNameCommand(message);
    return;
  }

  if (message.content.startsWith('!unmapname')) {
    await handleUnmapNameCommand(message);
    return;
  }

  if (message.content.startsWith('!namemap')) {
    await handleNameMapListCommand(message);
    return;
  }

  const rows = [...db.data.users]
    .sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''))
    .map((u) => {
      const a = u.attendance?.state || '-';
      const w = u.work?.state || '-';
      const mappedName = db.data.nameMappings?.[u.userId] || '-';
      const wSummary = u.work?.summary ? trim(u.work.summary, 50) : '';
      return `• **${u.displayName}** | 근태매핑: ${mappedName} | 근태: ${a} | 업무: ${w}${wSummary ? ` (${wSummary})` : ''}`;
    });

  const body = rows.length
    ? rows.join('\n')
    : '아직 수집된 상태가 없어요. (모니터링 채널에 메시지가 들어오면 자동 집계됩니다.)';

  await message.reply({
    content: `📊 **Team Snapshot**\n${body}`,
    allowedMentions: { repliedUser: false },
  });
}

async function handleLogsCommand(message) {
  const latestEvents = [...db.data.events]
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, 15)
    .map((e) => `• ${e.displayName} | ${e.kind}:${e.state} | ${trim(e.summary || '-', 60)} | ${new Date(e.at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`);

  await message.reply({
    content: latestEvents.length
      ? `🧾 **최근 이벤트(15개)**\n${latestEvents.join('\n')}`
      : '아직 이벤트 로그가 없어요.',
    allowedMentions: { repliedUser: false },
  });
}

async function handleLeaveCommand(message) {
  const parts = message.content.trim().split(/\s+/);
  const days = Math.max(1, Math.min(60, Number(parts[1] || 14)));
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const leaveStates = new Set(['오전반차', '오후반차', '반차', '휴가', '재택근무']);

  const picked = [...db.data.events]
    .filter((e) => e.kind === 'attendance' && leaveStates.has(e.state || '') && e.at)
    .filter((e) => new Date(e.at).getTime() >= sinceMs)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, 30)
    .map((e) => {
      const when = new Date(e.at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
      const who = e.attendanceName || e.displayName || 'unknown';
      return `• ${who} | ${e.state} | ${when}`;
    });

  await message.reply({
    content: picked.length
      ? `🏖️ **휴무/재택 현황 (최근 ${days}일, 최대 30건)**\n${picked.join('\n')}`
      : `최근 ${days}일 내 반차/연차/재택근무 기록이 없어요.`,
    allowedMentions: { repliedUser: false },
  });
}

async function handleMapNameCommand(message) {
  const parts = message.content.trim().split(/\s+/);
  if (parts.length < 3) {
    await message.reply({
      content: '사용법: `!mapname @유저 근태이름` 또는 `!mapname USER_ID 근태이름`',
      allowedMentions: { repliedUser: false },
    });
    return;
  }

  const mention = message.mentions.users.first();
  const targetUserId = mention?.id || parts[1].replace(/[^0-9]/g, '');
  const attendanceName = parts.slice(2).join(' ').trim();

  if (!targetUserId || !attendanceName) {
    await message.reply({
      content: '유저와 근태이름을 확인해줘. 예: `!mapname @Teny 텐이`',
      allowedMentions: { repliedUser: false },
    });
    return;
  }

  db.data.nameMappings[targetUserId] = attendanceName;
  touchMeta(new Date().toISOString());
  db.write();

  await message.reply({
    content: `✅ 매핑 저장: <@${targetUserId}> ↔ **${attendanceName}**`,
    allowedMentions: { repliedUser: false },
  });
}

async function handleUnmapNameCommand(message) {
  const parts = message.content.trim().split(/\s+/);
  const mention = message.mentions.users.first();
  const targetUserId = mention?.id || (parts[1] || '').replace(/[^0-9]/g, '');

  if (!targetUserId) {
    await message.reply({
      content: '사용법: `!unmapname @유저` 또는 `!unmapname USER_ID`',
      allowedMentions: { repliedUser: false },
    });
    return;
  }

  delete db.data.nameMappings[targetUserId];
  touchMeta(new Date().toISOString());
  db.write();

  await message.reply({
    content: `🗑️ 매핑 삭제: <@${targetUserId}>`,
    allowedMentions: { repliedUser: false },
  });
}

async function handleNameMapListCommand(message) {
  const rows = Object.entries(db.data.nameMappings || {}).map(([userId, attName]) => `• <@${userId}> ↔ **${attName}**`);

  await message.reply({
    content: rows.length ? `🧩 **근태 이름 매핑**\n${rows.join('\n')}` : '등록된 근태 이름 매핑이 없어요.',
    allowedMentions: { repliedUser: false },
  });
}

function getOrCreateUser(userId, displayName) {
  let row = db.data.users.find((u) => u.userId === userId);
  if (!row) {
    row = {
      userId,
      displayName,
      isBot: false,
      attendance: null,
      work: null,
      workLogs: [],
      updatedAt: new Date().toISOString(),
    };
    db.data.users.push(row);
  }
  return row;
}

function appendEvent(event) {
  db.data.events.push(event);
  if (db.data.events.length > 5000) {
    db.data.events = db.data.events.slice(-5000);
  }
}

async function mirrorPostgres(user, eventRow, attendanceByNameRow = null) {
  try {
    await pgStore.upsertUser(user.userId, user.displayName || null);
    await pgStore.upsertCurrentStatus(user);
    await pgStore.insertEvent(eventRow);
    if (eventRow.kind === 'attendance' && eventRow.attendanceName && attendanceByNameRow) {
      await pgStore.upsertAttendanceByName(eventRow.attendanceName, attendanceByNameRow);
    }
  } catch (err) {
    console.warn('[PG-MIRROR]', err.message);
  }
}

function touchMeta(nowIso) {
  db.data.meta ||= { createdAt: nowIso, updatedAt: nowIso };
  db.data.meta.updatedAt = nowIso;
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

function getAttendanceSourceText(message) {
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

  const merged = compact(chunks.join(' '));
  return merged || '(첨부/임베드 메시지)';
}

function extractAttendanceName(text) {
  const t = compact(text || '');
  if (!t) return null;

  // 예: "3월 4일(수) 이상민 ... 출근했습니다." / "... 퇴근했습니다."
  const dated = t.match(/^\d{1,2}월\s*\d{1,2}일(?:\([^)]*\))?\s+([가-힣A-Za-z]{2,12})/);
  if (dated?.[1]) return dated[1];

  // 예: "박정우 재택근무", "홍길동 연차", "김철수 반차"
  const leaveLike = t.match(/^([가-힣A-Za-z]{2,12})\s+(?:재택근무|연차|반차|휴가)\b/);
  if (leaveLike?.[1]) return leaveLike[1];

  // 일반 포맷 보조
  const basic = t.match(/^([가-힣A-Za-z]{2,12})\s+(?:근무|출근|퇴근|휴가|지각|외근|복귀)/);
  if (basic?.[1]) return basic[1];

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

function trim(text, n) {
  if (text.length <= n) return text;
  return `${text.slice(0, n - 1)}…`;
}
