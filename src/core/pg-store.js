require('dotenv').config();
const { Pool } = require('pg');

const MODE = String(process.env.DB_MODE || (process.env.DATABASE_URL ? 'dual' : 'json')).toLowerCase();
const DATABASE_URL = process.env.DATABASE_URL;
const pgEnabled = !!DATABASE_URL && (MODE === 'postgres' || MODE === 'dual');

const pool = pgEnabled ? new Pool({ connectionString: DATABASE_URL }) : null;

async function q(text, params = []) {
  if (!pool) throw new Error('Postgres not enabled');
  return pool.query(text, params);
}

async function upsertUser(userId, displayName, username = null, globalName = null) {
  await q(
    `insert into users(user_id, display_name, username, global_name, updated_at)
     values ($1,$2,$3,$4,now())
     on conflict (user_id) do update set
       display_name = coalesce(excluded.display_name, users.display_name),
       username = coalesce(excluded.username, users.username),
       global_name = coalesce(excluded.global_name, users.global_name),
       updated_at = now()`,
    [userId, displayName || null, username, globalName]
  );
}

async function upsertCurrentStatus(user) {
  const a = user.attendance || {};
  const w = user.work || {};
  await q(
    `insert into user_status_current(
      user_id, display_name,
      attendance_state, attendance_name, attendance_raw_text, attendance_channel_id, attendance_message_id, attendance_at,
      work_state, work_summary, work_channel_id, work_message_id, work_at,
      updated_at
    ) values (
      $1,$2,$3,$4,$5,$6,$7,$8,
      $9,$10,$11,$12,$13,
      now()
    )
    on conflict (user_id) do update set
      display_name = excluded.display_name,
      attendance_state = excluded.attendance_state,
      attendance_name = excluded.attendance_name,
      attendance_raw_text = excluded.attendance_raw_text,
      attendance_channel_id = excluded.attendance_channel_id,
      attendance_message_id = excluded.attendance_message_id,
      attendance_at = excluded.attendance_at,
      work_state = excluded.work_state,
      work_summary = excluded.work_summary,
      work_channel_id = excluded.work_channel_id,
      work_message_id = excluded.work_message_id,
      work_at = excluded.work_at,
      updated_at = now()`,
    [
      user.userId,
      user.displayName || null,
      a.state || null,
      a.attendanceName || null,
      a.rawText || null,
      a.channelId || null,
      a.messageId || null,
      a.at ? new Date(a.at) : null,
      w.state || null,
      w.summary || null,
      w.channelId || null,
      w.messageId || null,
      w.at ? new Date(w.at) : null,
    ]
  );
}

async function insertEvent(event) {
  await q(
    `insert into events(message_id, user_id, display_name, kind, state, summary, attendance_name, channel_id, occurred_at, raw_payload)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (message_id) where message_id is not null do update set
       attendance_name = coalesce(excluded.attendance_name, events.attendance_name),
       summary = coalesce(excluded.summary, events.summary),
       raw_payload = coalesce(excluded.raw_payload, events.raw_payload)`,
    [
      event.messageId || null,
      event.userId || null,
      event.displayName || null,
      event.kind || 'work',
      event.state || null,
      event.summary || null,
      event.attendanceName || null,
      event.channelId || null,
      event.at ? new Date(event.at) : new Date(),
      event,
    ]
  );
}

async function insertWorkLog(userId, row) {
  await q(
    `insert into user_work_logs(user_id, state, summary, channel_id, message_id, occurred_at)
     values ($1,$2,$3,$4,$5,$6)`,
    [
      userId,
      row.state || null,
      row.summary || null,
      row.channelId || null,
      row.messageId || null,
      row.at ? new Date(row.at) : new Date(),
    ]
  );
}

async function upsertAttendanceByName(name, row) {
  await q(
    `insert into attendance_by_name_current(attendance_name, state, raw_text, channel_id, message_id, occurred_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,now())
     on conflict (attendance_name) do update set
       state = excluded.state,
       raw_text = excluded.raw_text,
       channel_id = excluded.channel_id,
       message_id = excluded.message_id,
       occurred_at = excluded.occurred_at,
       updated_at = now()`,
    [name, row.state || null, row.rawText || null, row.channelId || null, row.messageId || null, row.at ? new Date(row.at) : null]
  );
}

async function getDashboardStatus() {
  const usersRes = await q(
    `select u.user_id,
            coalesce(s.display_name, u.display_name) as display_name,
            s.attendance_state, s.attendance_name, s.attendance_raw_text, s.attendance_channel_id, s.attendance_message_id, s.attendance_at,
            s.work_state, s.work_summary, s.work_channel_id, s.work_message_id, s.work_at,
            s.updated_at,
            cs.character_sheet,
            m.attendance_name as attendance_alias
     from users u
     left join user_status_current s on s.user_id = u.user_id
     left join mappings_character_selection cs on cs.user_id = u.user_id
     left join mappings_attendance_name m on m.user_id = u.user_id
     order by coalesce(s.display_name, u.display_name, u.user_id)`
  );

  const mapRes = await q(`select attendance_name, user_id, display_name, username, global_name, updated_at from mappings_attendance_name`);
  const byNameRes = await q(`select attendance_name, state, raw_text, channel_id, message_id, occurred_at from attendance_by_name_current`);

  const users = usersRes.rows.map((r) => ({
    userId: r.user_id,
    displayName: r.display_name,
    attendanceAlias: r.attendance_alias || null,
    characterSheet: r.character_sheet || null,
    attendance: r.attendance_state
      ? {
          state: r.attendance_state,
          attendanceName: r.attendance_name,
          rawText: r.attendance_raw_text,
          channelId: r.attendance_channel_id,
          messageId: r.attendance_message_id,
          at: r.attendance_at ? new Date(r.attendance_at).toISOString() : null,
        }
      : null,
    work: r.work_state
      ? {
          state: r.work_state,
          summary: r.work_summary,
          channelId: r.work_channel_id,
          messageId: r.work_message_id,
          at: r.work_at ? new Date(r.work_at).toISOString() : null,
        }
      : null,
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  }));

  const attendanceMappings = {};
  const attendanceNameToUserId = {};
  for (const r of mapRes.rows) {
    attendanceNameToUserId[r.attendance_name] = r.user_id;
    attendanceMappings[r.attendance_name] = {
      userId: r.user_id,
      displayName: r.display_name,
      username: r.username,
      globalName: r.global_name,
      updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    };
  }

  const todayAttendanceByName = {};
  for (const r of byNameRes.rows) {
    todayAttendanceByName[r.attendance_name] = {
      state: r.state,
      rawText: r.raw_text,
      channelId: r.channel_id,
      messageId: r.message_id,
      at: r.occurred_at ? new Date(r.occurred_at).toISOString() : null,
    };
  }

  const summary = {
    total: users.length,
    attendance: { 출근:0, 퇴근:0, 휴가:0, 반차:0, 재택근무:0, 자리비움:0, 지각:0, 복귀:0, 업데이트:0, unknown:0 },
    work: { 진행중:0, 완료:0, 대기:0, 이슈:0, 리뷰중:0, 업데이트:0, unknown:0 },
  };
  for (const u of users) {
    const a = u.attendance?.state || 'unknown';
    const w = u.work?.state || 'unknown';
    summary.attendance[a] = (summary.attendance[a] || 0) + 1;
    summary.work[w] = (summary.work[w] || 0) + 1;
  }

  return {
    meta: { updatedAt: new Date().toISOString() },
    summary,
    users,
    attendanceNameToUserId,
    attendanceMappings,
    characterSelections: Object.fromEntries(users.filter((u)=>u.characterSheet).map((u)=>[u.userId,u.characterSheet])),
    todayAttendanceByName,
  };
}

async function getLogs(limit = 30) {
  const res = await q(
    `select user_id, display_name, kind, state, summary, attendance_name, channel_id, message_id, occurred_at, raw_payload
     from events
     order by occurred_at desc
     limit $1`,
    [limit]
  );

  return {
    totalEvents: Number((await q('select count(*)::int as c from events')).rows[0].c || 0),
    rows: res.rows.map((r) => ({
      userId: r.user_id,
      displayName: r.display_name,
      kind: r.kind,
      state: r.state,
      summary: r.summary,
      attendanceName: r.attendance_name,
      channelId: r.channel_id,
      messageId: r.message_id,
      at: r.occurred_at ? new Date(r.occurred_at).toISOString() : null,
      scheduledFor: r.raw_payload?.scheduledFor || null,
      durationText: r.raw_payload?.durationText || null,
    })),
  };
}

async function applyAttendanceMappings(mappings = {}, memberById = {}) {
  for (const [attendanceNameRaw, userIdRaw] of Object.entries(mappings)) {
    const attendanceName = String(attendanceNameRaw || '').trim();
    const userId = String(userIdRaw || '').trim();
    if (!attendanceName || !/^\d+$/.test(userId)) continue;
    const m = memberById[userId] || {};
    await upsertUser(userId, m.displayName || null, m.username || null, m.globalName || null);
    await q(
      `insert into mappings_attendance_name(attendance_name, user_id, display_name, username, global_name, updated_at)
       values ($1,$2,$3,$4,$5,now())
       on conflict (attendance_name) do update set
         user_id = excluded.user_id,
         display_name = excluded.display_name,
         username = excluded.username,
         global_name = excluded.global_name,
         updated_at = now()`,
      [attendanceName, userId, m.displayName || null, m.username || null, m.globalName || null]
    );
  }
}

async function applyCharacterSelections(selections = {}) {
  for (const [userIdRaw, sheetRaw] of Object.entries(selections)) {
    const userId = String(userIdRaw || '').trim();
    const sheet = String(sheetRaw || '').trim();
    if (!/^\d+$/.test(userId) || !sheet) continue;
    await upsertUser(userId, null, null, null);
    await q(
      `insert into mappings_character_selection(user_id, character_sheet, updated_at)
       values ($1,$2,now())
       on conflict (user_id) do update set
         character_sheet = excluded.character_sheet,
         updated_at = now()`,
      [userId, sheet]
    );
  }
}

module.exports = {
  MODE,
  pgEnabled,
  upsertUser,
  upsertCurrentStatus,
  insertEvent,
  insertWorkLog,
  upsertAttendanceByName,
  getDashboardStatus,
  getLogs,
  applyAttendanceMappings,
  applyCharacterSelections,
};
