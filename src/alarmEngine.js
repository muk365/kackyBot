import { formatAlarmMessage } from './tmFormat.js';
import { sendWizebotCustomEvent } from './wizebotService.js';

export function createAlarmEngine({ db, kackyClient, twitchService, onAlarmTriggered = null }) {
  let timer = null;
  const inFlight = new Set();

  async function dispatchProvider({
    alarm,
    server,
    message,
    secondsRemaining,
    provider,
    dedupeKey,
    nowMs,
  }) {
    const lockKey = `${alarm.twitch_user_id}:${server.login}:${server.nextMap.mapNumber}:${provider}`;
    if (
      inFlight.has(lockKey) ||
      db.hasAlarmLog(dedupeKey) ||
      db.hasBeenAlerted({
        twitchUserId: alarm.twitch_user_id,
        serverLogin: server.login,
        mapNumber: server.nextMap.mapNumber,
        provider,
        mapStartedAt: server.mapStartedAt || '',
        mapEndsAt: server.mapEndsAt || '',
        nowMs,
      })
    ) {
      return null;
    }
    inFlight.add(lockKey);

    let status = 'sent';
    let errorDetail = '';

    try {
      if (provider === 'twitch') {
        await twitchService.sendChatMessage(alarm, message);
      } else if (provider === 'wizebot') {
        await sendWizebotCustomEvent(alarm.wizebot_api_key, {
          event: 'kacky_alarm',
          mapNumber: server.nextMap.mapNumber,
          mapName: server.nextMap.name,
          mapUid: server.nextMap.mapUid,
          serverName: server.name,
          serverNumber: server.serverNumber,
          secondsRemaining,
          channel: alarm.twitch_login,
          message,
          mapEndsAt: server.mapEndsAt,
        });
      }
    } catch (err) {
      status = 'error';
      errorDetail = err.message || 'Unknown delivery error';
      console.error(
        `[alarmEngine] Failed ${provider} alarm for @${alarm.twitch_login} map #${server.nextMap.mapNumber}:`,
        errorDetail
      );
    } finally {
      inFlight.delete(lockKey);
    }

    const entry = {
      twitchUserId: alarm.twitch_user_id,
      eventId: server.eventId || alarm.event_id,
      serverLogin: server.login,
      serverName: server.name,
      mapNumber: server.nextMap.mapNumber,
      mapUid: server.nextMap.mapUid || '',
      dedupeKey,
      channelLogin: alarm.twitch_login,
      provider,
      status,
      message,
      errorDetail,
      triggeredAt: nowMs,
    };

    db.insertAlarmLog(entry);
    db.recordAlertedMap({
      twitchUserId: alarm.twitch_user_id,
      eventId: entry.eventId,
      serverLogin: server.login,
      mapNumber: server.nextMap.mapNumber,
      provider,
      mapStartedAt: server.mapStartedAt || '',
      mapEndsAt: server.mapEndsAt || '',
      alertedAt: nowMs,
    });
    if (onAlarmTriggered) {
      onAlarmTriggered(entry);
    }
    return entry;
  }

  async function evaluateOnce(nowMs = Date.now()) {
    const { servers } = kackyClient.getState();
    if (!servers || servers.length === 0) return [];

    const enabledAlarms = db.getAllEnabledAlarms();
    if (!enabledAlarms || enabledAlarms.length === 0) return [];

    const alarmsByKey = new Map();
    for (const row of enabledAlarms) {
      const key = `${row.event_id}:${row.map_number}`;
      const bucket = alarmsByKey.get(key);
      if (bucket) {
        bucket.push(row);
      } else {
        alarmsByKey.set(key, [row]);
      }
    }

    const jobs = [];

    for (const server of servers) {
      if (server.status !== 'RUNNING' || !server.nextMap || !server.mapEndsAt) continue;

      const endsAtMs = Date.parse(server.mapEndsAt);
      if (Number.isNaN(endsAtMs)) continue;

      const remainingMs = endsAtMs - nowMs;
      if (remainingMs <= 0) continue;

      const lookupKey = `${server.eventId}:${server.nextMap.mapNumber}`;
      const subscribers = alarmsByKey.get(lookupKey);
      if (!subscribers || subscribers.length === 0) continue;

      for (const alarm of subscribers) {
        const thresholdMs = (Number(alarm.alarm_seconds) || 60) * 1000;
        if (remainingMs > thresholdMs) continue;

        const secondsRemaining = Math.max(1, Math.round(remainingMs / 1000));
        const message = formatAlarmMessage(alarm.message_template, {
          mapNumber: server.nextMap.mapNumber,
          mapName: server.nextMap.name,
          serverName: server.name,
          serverNumber: server.serverNumber,
          seconds: secondsRemaining,
          currentMapNumber: server.currentMap?.mapNumber ?? '',
        });

        const baseKey = `${alarm.twitch_user_id}:${server.login}:${server.nextMap.mapNumber}:${server.mapEndsAt}`;

        if (alarm.twitch_chat_enabled) {
          jobs.push(
            dispatchProvider({
              alarm,
              server,
              message,
              secondsRemaining,
              provider: 'twitch',
              dedupeKey: `${baseKey}:twitch`,
              nowMs,
            })
          );
        }

        if (alarm.wizebot_enabled && alarm.wizebot_api_key) {
          jobs.push(
            dispatchProvider({
              alarm,
              server,
              message,
              secondsRemaining,
              provider: 'wizebot',
              dedupeKey: `${baseKey}:wizebot`,
              nowMs,
            })
          );
        }
      }
    }

    if (jobs.length === 0) return [];
    const results = await Promise.all(jobs);
    return results.filter(Boolean);
  }

  function start(intervalMs = 1000) {
    if (timer) return;
    timer = setInterval(() => {
      evaluateOnce().catch((err) => {
        console.error('[alarmEngine] Tick error:', err);
      });
    }, intervalMs);
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    start,
    stop,
    evaluateOnce,
  };
}
