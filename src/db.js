import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_MESSAGE_TEMPLATE } from './tmFormat.js';

export { DEFAULT_MESSAGE_TEMPLATE };

const LEGACY_MESSAGE_TEMPLATE =
  '⏰ Kacky Alarm! Map #{mapNumber} ({mapName}) starts in {seconds}s on {serverName}!';

/**
 * Initialize SQLite database and expose typed data access helpers.
 * @param {string} dbPath
 */
export function createDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      twitch_user_id TEXT PRIMARY KEY,
      twitch_login TEXT NOT NULL,
      display_name TEXT NOT NULL,
      profile_image_url TEXT DEFAULT '',
      access_token TEXT DEFAULT '',
      refresh_token TEXT DEFAULT '',
      token_expires_at INTEGER DEFAULT 0,
      twitch_chat_enabled INTEGER NOT NULL DEFAULT 1,
      wizebot_enabled INTEGER NOT NULL DEFAULT 0,
      wizebot_api_key TEXT DEFAULT '',
      alarm_seconds INTEGER NOT NULL DEFAULT 60,
      message_template TEXT NOT NULL DEFAULT '${DEFAULT_MESSAGE_TEMPLATE.replaceAll("'", "''")}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      twitch_user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (twitch_user_id) REFERENCES users(twitch_user_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS map_alarms (
      twitch_user_id TEXT NOT NULL,
      event_id INTEGER NOT NULL,
      map_number INTEGER NOT NULL,
      map_uid TEXT DEFAULT '',
      map_name TEXT DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (twitch_user_id, event_id, map_number),
      FOREIGN KEY (twitch_user_id) REFERENCES users(twitch_user_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS alarm_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      twitch_user_id TEXT NOT NULL,
      event_id INTEGER NOT NULL,
      server_login TEXT NOT NULL,
      server_name TEXT NOT NULL,
      map_number INTEGER NOT NULL,
      map_uid TEXT DEFAULT '',
      dedupe_key TEXT NOT NULL UNIQUE,
      channel_login TEXT NOT NULL,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT NOT NULL,
      error_detail TEXT DEFAULT '',
      triggered_at INTEGER NOT NULL,
      FOREIGN KEY (twitch_user_id) REFERENCES users(twitch_user_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS alerted_maps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      twitch_user_id TEXT NOT NULL,
      event_id INTEGER NOT NULL,
      server_login TEXT NOT NULL,
      map_number INTEGER NOT NULL,
      provider TEXT NOT NULL,
      map_started_at TEXT DEFAULT '',
      map_ends_at TEXT DEFAULT '',
      alerted_at INTEGER NOT NULL,
      FOREIGN KEY (twitch_user_id) REFERENCES users(twitch_user_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_map_alarms_enabled
      ON map_alarms (event_id, map_number, enabled);

    CREATE INDEX IF NOT EXISTS idx_alarm_logs_user_time
      ON alarm_logs (twitch_user_id, triggered_at DESC);

    CREATE INDEX IF NOT EXISTS idx_alerted_maps_lookup
      ON alerted_maps (twitch_user_id, server_login, map_number, provider, alerted_at DESC);
  `);

  // Upgrade existing rows still using the legacy emoji default template
  db.prepare('UPDATE users SET message_template = ? WHERE message_template = ?').run(
    DEFAULT_MESSAGE_TEMPLATE,
    LEGACY_MESSAGE_TEMPLATE
  );

  const stmts = {
    upsertUser: db.prepare(`
      INSERT INTO users (
        twitch_user_id, twitch_login, display_name, profile_image_url,
        access_token, refresh_token, token_expires_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(twitch_user_id) DO UPDATE SET
        twitch_login = excluded.twitch_login,
        display_name = excluded.display_name,
        profile_image_url = excluded.profile_image_url,
        access_token = excluded.access_token,
        refresh_token = CASE
          WHEN excluded.refresh_token != '' THEN excluded.refresh_token
          ELSE users.refresh_token
        END,
        token_expires_at = excluded.token_expires_at,
        updated_at = excluded.updated_at
    `),
    getUserById: db.prepare('SELECT * FROM users WHERE twitch_user_id = ?'),
    updateTokens: db.prepare(`
      UPDATE users
      SET access_token = ?, refresh_token = ?, token_expires_at = ?, updated_at = ?
      WHERE twitch_user_id = ?
    `),
    updateSettings: db.prepare(`
      UPDATE users
      SET twitch_chat_enabled = ?,
          wizebot_enabled = ?,
          wizebot_api_key = ?,
          alarm_seconds = ?,
          message_template = ?,
          updated_at = ?
      WHERE twitch_user_id = ?
    `),
    insertSession: db.prepare(
      'INSERT INTO sessions (token, twitch_user_id, expires_at) VALUES (?, ?, ?)'
    ),
    getSession: db.prepare(`
      SELECT s.token, s.expires_at, u.*
      FROM sessions s
      JOIN users u ON u.twitch_user_id = s.twitch_user_id
      WHERE s.token = ? AND s.expires_at > ?
    `),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
    pruneSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    upsertAlarm: db.prepare(`
      INSERT INTO map_alarms (
        twitch_user_id, event_id, map_number, map_uid, map_name, enabled, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(twitch_user_id, event_id, map_number) DO UPDATE SET
        map_uid = excluded.map_uid,
        map_name = excluded.map_name,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `),
    getUserAlarms: db.prepare(`
      SELECT map_number, map_uid, map_name, enabled, updated_at
      FROM map_alarms
      WHERE twitch_user_id = ? AND event_id = ?
    `),
    getEnabledAlarmsForLookup: db.prepare(`
      SELECT
        m.twitch_user_id,
        m.event_id,
        m.map_number,
        m.map_uid,
        m.map_name,
        u.twitch_login,
        u.display_name,
        u.access_token,
        u.refresh_token,
        u.token_expires_at,
        u.twitch_chat_enabled,
        u.wizebot_enabled,
        u.wizebot_api_key,
        u.alarm_seconds,
        u.message_template
      FROM map_alarms m
      JOIN users u ON u.twitch_user_id = m.twitch_user_id
      WHERE m.enabled = 1
    `),
    hasAlarmLog: db.prepare('SELECT 1 FROM alarm_logs WHERE dedupe_key = ? LIMIT 1'),
    insertAlarmLog: db.prepare(`
      INSERT OR IGNORE INTO alarm_logs (
        twitch_user_id, event_id, server_login, server_name,
        map_number, map_uid, dedupe_key, channel_login,
        provider, status, message, error_detail, triggered_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    getAlarmLogs: db.prepare(`
      SELECT *
      FROM alarm_logs
      WHERE twitch_user_id = ?
      ORDER BY triggered_at DESC, id DESC
      LIMIT ?
    `),
    getRecentAlertForMap: db.prepare(`
      SELECT map_started_at, map_ends_at, alerted_at
      FROM alerted_maps
      WHERE twitch_user_id = ?
        AND server_login = ?
        AND map_number = ?
        AND provider = ?
      ORDER BY alerted_at DESC
      LIMIT 5
    `),
    insertAlertedMap: db.prepare(`
      INSERT INTO alerted_maps (
        twitch_user_id, event_id, server_login, map_number,
        provider, map_started_at, map_ends_at, alerted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    getRecentAlertedMapsForUser: db.prepare(`
      SELECT server_login, map_number, provider, map_started_at, map_ends_at, alerted_at
      FROM alerted_maps
      WHERE twitch_user_id = ? AND alerted_at >= ?
      ORDER BY alerted_at DESC
    `),
    pruneOldAlertedMaps: db.prepare('DELETE FROM alerted_maps WHERE alerted_at < ?'),
  };

  return {
    upsertUser(user) {
      const now = Date.now();
      stmts.upsertUser.run(
        user.twitchUserId,
        user.twitchLogin,
        user.displayName,
        user.profileImageUrl || '',
        user.accessToken || '',
        user.refreshToken || '',
        user.tokenExpiresAt || 0,
        now,
        now
      );
      return stmts.getUserById.get(user.twitchUserId);
    },

    getUserById(twitchUserId) {
      return stmts.getUserById.get(twitchUserId) || null;
    },

    updateUserTokens(twitchUserId, accessToken, refreshToken, tokenExpiresAt) {
      stmts.updateTokens.run(
        accessToken,
        refreshToken || '',
        tokenExpiresAt || 0,
        Date.now(),
        twitchUserId
      );
    },

    updateUserSettings(twitchUserId, settings) {
      const alarmSeconds = Math.min(300, Math.max(5, Number(settings.alarmSeconds) || 60));
      const template =
        typeof settings.messageTemplate === 'string' && settings.messageTemplate.trim()
          ? settings.messageTemplate.trim().slice(0, 450)
          : DEFAULT_MESSAGE_TEMPLATE;

      stmts.updateSettings.run(
        settings.twitchChatEnabled ? 1 : 0,
        settings.wizebotEnabled ? 1 : 0,
        String(settings.wizebotApiKey || '').trim(),
        alarmSeconds,
        template,
        Date.now(),
        twitchUserId
      );
      return stmts.getUserById.get(twitchUserId);
    },

    createSession(twitchUserId, ttlMs = 30 * 24 * 60 * 60 * 1000) {
      const now = Date.now();
      stmts.pruneSessions.run(now);
      const token = crypto.randomBytes(32).toString('hex');
      stmts.insertSession.run(token, twitchUserId, now + ttlMs);
      return token;
    },

    getSessionUser(token) {
      if (!token) return null;
      return stmts.getSession.get(token, Date.now()) || null;
    },

    deleteSession(token) {
      if (!token) return;
      stmts.deleteSession.run(token);
    },

    setMapAlarm(twitchUserId, eventId, mapNumber, enabled, mapUid = '', mapName = '') {
      stmts.upsertAlarm.run(
        twitchUserId,
        Number(eventId),
        Number(mapNumber),
        mapUid,
        mapName,
        enabled ? 1 : 0,
        Date.now()
      );
    },

    setBulkMapAlarms(twitchUserId, eventId, maps, enabled) {
      const now = Date.now();
      db.exec('BEGIN');
      try {
        for (const m of maps) {
          stmts.upsertAlarm.run(
            twitchUserId,
            Number(eventId),
            Number(m.mapNumber),
            m.mapUid || '',
            m.name || m.mapName || '',
            enabled ? 1 : 0,
            now
          );
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    getMapAlarmsForUser(twitchUserId, eventId) {
      return stmts.getUserAlarms.all(twitchUserId, Number(eventId));
    },

    getAllEnabledAlarms() {
      return stmts.getEnabledAlarmsForLookup.all();
    },

    hasAlarmLog(dedupeKey) {
      return Boolean(stmts.hasAlarmLog.get(dedupeKey));
    },

    insertAlarmLog(entry) {
      stmts.insertAlarmLog.run(
        entry.twitchUserId,
        Number(entry.eventId),
        entry.serverLogin,
        entry.serverName,
        Number(entry.mapNumber),
        entry.mapUid || '',
        entry.dedupeKey,
        entry.channelLogin,
        entry.provider,
        entry.status,
        entry.message,
        entry.errorDetail || '',
        entry.triggeredAt || Date.now()
      );
    },

    getAlarmLogsForUser(twitchUserId, limit = 50) {
      return stmts.getAlarmLogs.all(twitchUserId, limit);
    },

    /**
     * Check whether this (user, server, mapNumber, provider) was already alerted
     * for the current map rotation cycle. Protects against refreshes, timer jitter,
     * time extensions, and server restarts.
     */
    hasBeenAlerted({
      twitchUserId,
      serverLogin,
      mapNumber,
      provider,
      mapStartedAt = '',
      mapEndsAt = '',
      nowMs = Date.now(),
    }) {
      const rows = stmts.getRecentAlertForMap.all(
        twitchUserId,
        serverLogin,
        Number(mapNumber),
        provider
      );
      const curEndsMs = mapEndsAt ? Date.parse(mapEndsAt) : NaN;
      const fiveMinutesMs = 5 * 60 * 1000;

      for (const row of rows) {
        if (mapStartedAt && row.map_started_at && row.map_started_at === mapStartedAt) {
          return true;
        }
        if (Number.isFinite(curEndsMs) && row.map_ends_at) {
          const prevEndsMs = Date.parse(row.map_ends_at);
          if (Number.isFinite(prevEndsMs) && Math.abs(prevEndsMs - curEndsMs) < fiveMinutesMs) {
            return true;
          }
        }
        if (nowMs - Number(row.alerted_at) < fiveMinutesMs) {
          return true;
        }
      }
      return false;
    },

    recordAlertedMap({
      twitchUserId,
      eventId,
      serverLogin,
      mapNumber,
      provider,
      mapStartedAt = '',
      mapEndsAt = '',
      alertedAt = Date.now(),
    }) {
      // Keep alerted_maps table bounded (prune entries older than 7 days)
      stmts.pruneOldAlertedMaps.run(alertedAt - 7 * 24 * 60 * 60 * 1000);
      stmts.insertAlertedMap.run(
        twitchUserId,
        Number(eventId),
        serverLogin,
        Number(mapNumber),
        provider,
        mapStartedAt || '',
        mapEndsAt || '',
        alertedAt
      );
    },

    getRecentAlertedMapsForUser(twitchUserId, sinceMs = Date.now() - 60 * 60 * 1000) {
      return stmts.getRecentAlertedMapsForUser.all(twitchUserId, sinceMs);
    },

    close() {
      db.close();
    },
  };
}
