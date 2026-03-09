#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const ROOT = path.resolve(__dirname, '..');
const DB_FILE = path.join(ROOT, 'data', 'team-status-db.json');
const SCHEMA_FILE = path.join(ROOT, 'db', 'postgres', 'schema.sql');

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }
  if (!fs.existsSync(DB_FILE)) {
    throw new Error(`JSON DB not found: ${DB_FILE}`);
  }

  const raw = fs.readFileSync(DB_FILE, 'utf8');
  const src = JSON.parse(raw);
  src.users ||= [];
  src.events ||= [];
  src.attendanceMappings ||= {};
  src.characterSelections ||= {};
  src.attendanceByName ||= {};

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await client.query('begin');

    const schemaSql = fs.readFileSync(SCHEMA_FILE, 'utf8');
    await client.query(schemaSql);

    for (const u of src.users) {
      await client.query(
        `insert into users(user_id, display_name, updated_at)
         values ($1,$2,now())
         on conflict (user_id) do update set
           display_name = excluded.display_name,
           updated_at = now()`,
        [u.userId, u.displayName || null]
      );

      const a = u.attendance || {};
      const w = u.work || {};
      await client.query(
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
          u.userId,
          u.displayName || null,
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

      for (const wl of (u.workLogs || [])) {
        await client.query(
          `insert into user_work_logs(user_id, state, summary, channel_id, message_id, occurred_at)
           values ($1,$2,$3,$4,$5,$6)
           on conflict do nothing`,
          [
            u.userId,
            wl.state || null,
            wl.summary || null,
            wl.channelId || null,
            wl.messageId || null,
            wl.at ? new Date(wl.at) : new Date(),
          ]
        );
      }
    }

    for (const e of src.events) {
      await client.query(
        `insert into events(message_id, user_id, display_name, kind, state, summary, attendance_name, channel_id, occurred_at, raw_payload)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict do nothing`,
        [
          e.messageId || null,
          e.userId || null,
          e.displayName || null,
          e.kind || 'work',
          e.state || null,
          e.summary || null,
          e.attendanceName || null,
          e.channelId || null,
          e.at ? new Date(e.at) : new Date(),
          e,
        ]
      );
    }

    for (const [attendanceName, row] of Object.entries(src.attendanceMappings || {})) {
      await client.query(
        `insert into users(user_id, display_name, username, global_name, updated_at)
         values ($1,$2,$3,$4,now())
         on conflict (user_id) do update set
           display_name = coalesce(excluded.display_name, users.display_name),
           username = coalesce(excluded.username, users.username),
           global_name = coalesce(excluded.global_name, users.global_name),
           updated_at = now()`,
        [row.userId, row.displayName || null, row.username || null, row.globalName || null]
      );

      await client.query(
        `insert into mappings_attendance_name(attendance_name, user_id, display_name, username, global_name, updated_at)
         values ($1,$2,$3,$4,$5,coalesce($6,now()))
         on conflict (attendance_name) do update set
           user_id = excluded.user_id,
           display_name = excluded.display_name,
           username = excluded.username,
           global_name = excluded.global_name,
           updated_at = excluded.updated_at`,
        [
          attendanceName,
          row.userId,
          row.displayName || null,
          row.username || null,
          row.globalName || null,
          row.updatedAt ? new Date(row.updatedAt) : null,
        ]
      );
    }

    for (const [userId, sheet] of Object.entries(src.characterSelections || {})) {
      await client.query(
        `insert into users(user_id, updated_at)
         values ($1,now())
         on conflict (user_id) do update set
           updated_at = now()`,
        [userId]
      );

      await client.query(
        `insert into mappings_character_selection(user_id, character_sheet, updated_at)
         values ($1,$2,now())
         on conflict (user_id) do update set
           character_sheet = excluded.character_sheet,
           updated_at = now()`,
        [userId, sheet]
      );
    }

    for (const [attendanceName, row] of Object.entries(src.attendanceByName || {})) {
      await client.query(
        `insert into attendance_by_name_current(attendance_name, state, raw_text, channel_id, message_id, occurred_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,now())
         on conflict (attendance_name) do update set
           state = excluded.state,
           raw_text = excluded.raw_text,
           channel_id = excluded.channel_id,
           message_id = excluded.message_id,
           occurred_at = excluded.occurred_at,
           updated_at = now()`,
        [
          attendanceName,
          row.state || null,
          row.rawText || null,
          row.channelId || null,
          row.messageId || null,
          row.at ? new Date(row.at) : null,
        ]
      );
    }

    await client.query('commit');
    console.log('[OK] migrated JSON -> PostgreSQL');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[ERROR]', err.message);
  process.exit(1);
});
