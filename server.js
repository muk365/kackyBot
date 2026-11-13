import 'dotenv/config';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { createDatabase, DEFAULT_MESSAGE_TEMPLATE } from './src/db.js';
import { createKackyClient } from './src/kackyClient.js';
import { createTwitchService } from './src/twitchService.js';
import { createAlarmEngine } from './src/alarmEngine.js';
import { sendWizebotCustomEvent } from './src/wizebotService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseCookies(cookieHeader) {
  const result = {};
  if (!cookieHeader) return result;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    try {
      result[key] = decodeURIComponent(val);
    } catch {
      result[key] = val;
    }
  }
  return result;
}

function sanitizeUser(row) {
  if (!row) return null;
  return {
    twitchUserId: row.twitch_user_id,
    twitchLogin: row.twitch_login,
    displayName: row.display_name,
    profileImageUrl: row.profile_image_url || '',
    twitchChatEnabled: Boolean(row.twitch_chat_enabled),
    wizebotEnabled: Boolean(row.wizebot_enabled),
    wizebotApiKey: row.wizebot_api_key || '',
    alarmSeconds: Number(row.alarm_seconds || 60),
    messageTemplate: row.message_template || DEFAULT_MESSAGE_TEMPLATE,
    hasTwitchToken: Boolean(row.access_token),
    hasSavedSettings: Boolean(row.has_saved_settings),
  };
}

export function createApp(options = {}) {
  const port = Number(options.port ?? process.env.PORT ?? 3000);
  const host = options.host ?? process.env.HOST ?? '0.0.0.0';
  const inferredHostUrl =
    process.env.BASE_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '') ||
    (process.env.KOYEB_PUBLIC_DOMAIN ? `https://${process.env.KOYEB_PUBLIC_DOMAIN}` : '') ||
    `http://localhost:${port}`;
  const baseUrl = (options.baseUrl ?? inferredHostUrl).replace(/\/+$/, '');
  const isHttps = baseUrl.startsWith('https://');
  const dbPath =
    options.dbPath ??
    path.resolve(__dirname, process.env.DB_PATH || './data/kackyalarm.sqlite');
  const pollIntervalMs = Number(
    options.pollIntervalMs ?? process.env.KACKY_POLL_INTERVAL_MS ?? 15000
  );
  const defaultArmedMaps = String(
    options.defaultArmedMaps ?? process.env.DEFAULT_ARMED_MAPS ?? ''
  )
    .split(/[,\s]+/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);

  const db = createDatabase(dbPath);
  const twitchService = createTwitchService({
    clientId: options.twitchClientId ?? process.env.TWITCH_CLIENT_ID ?? '',
    clientSecret: options.twitchClientSecret ?? process.env.TWITCH_CLIENT_SECRET ?? '',
    redirectUri:
      options.twitchRedirectUri ??
      process.env.TWITCH_REDIRECT_URI ??
      `${baseUrl}/auth/twitch/callback`,
    db,
  });

  const sseClients = new Set();

  function broadcastSse(event, payload, targetUserId = null) {
    const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of sseClients) {
      if (targetUserId && client.userId !== targetUserId) continue;
      client.res.write(data);
    }
  }

  const kackyClient = createKackyClient({
    pollIntervalMs,
    onServersUpdate(state) {
      broadcastSse('servers', {
        servers: state.servers,
        lastServersSyncAt: state.lastServersSyncAt,
        lastServersError: state.lastServersError,
        serverTime: Date.now(),
      });
    },
  });

  const alarmEngine = createAlarmEngine({
    db,
    kackyClient,
    twitchService,
    onAlarmTriggered(entry) {
      broadcastSse('alarm', entry, entry.twitchUserId);
    },
  });

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());

  app.get('/health', (_req, res) => {
    const kacky = kackyClient.getState();
    res.json({
      ok: true,
      uptime: Math.round(process.uptime()),
      servers: kacky.servers.length,
      maps: kacky.maps.length,
      lastServersSyncAt: kacky.lastServersSyncAt,
    });
  });

  // Attach authenticated user if session cookie is present
  app.use((req, _res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    req.cookies = cookies;
    req.user = cookies.kacky_session ? db.getSessionUser(cookies.kacky_session) : null;
    next();
  });

  function requireAuth(req, res, next) {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required. Please log in with Twitch.' });
    }
    return next();
  }

  // --- Twitch OAuth Routes ---
  app.get('/auth/twitch', (req, res) => {
    if (!twitchService.isConfigured()) {
      return res.redirect('/?auth_error=twitch_not_configured');
    }
    const state = crypto.randomBytes(24).toString('hex');
    res.cookie('twitch_oauth_state', state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: isHttps,
      maxAge: 10 * 60 * 1000,
    });
    return res.redirect(twitchService.getAuthorizeUrl(state));
  });

  app.get('/auth/twitch/callback', async (req, res) => {
    const { code, state, error, error_description: errorDesc } = req.query;
    if (error) {
      return res.redirect(
        `/?auth_error=${encodeURIComponent(String(errorDesc || error))}`
      );
    }
    if (!state || state !== req.cookies.twitch_oauth_state) {
      return res.redirect('/?auth_error=invalid_oauth_state');
    }
    res.clearCookie('twitch_oauth_state');

    if (!code) {
      return res.redirect('/?auth_error=missing_code');
    }

    try {
      const tokens = await twitchService.exchangeCode(String(code));
      const profile = await twitchService.fetchCurrentUser(tokens.accessToken);
      db.upsertUser({
        ...profile,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        tokenExpiresAt: tokens.expiresAt,
      });

      const kacky = kackyClient.getState();
      const eventId = kacky.activeEvent?.id ?? kacky.servers[0]?.eventId ?? null;
      if (eventId && defaultArmedMaps.length > 0) {
        const existing = db.getMapAlarmsForUser(profile.twitchUserId, eventId);
        if (existing.length === 0) {
          const byNumber = new Map(kacky.maps.map((m) => [m.mapNumber, m]));
          const targets = defaultArmedMaps.map((num) => ({
            mapNumber: num,
            mapUid: byNumber.get(num)?.mapUid || '',
            name: byNumber.get(num)?.name || `#${num}`,
          }));
          db.setBulkMapAlarms(profile.twitchUserId, eventId, targets, true);
        }
      }

      const sessionToken = db.createSession(profile.twitchUserId);
      res.cookie('kacky_session', sessionToken, {
        httpOnly: true,
        sameSite: 'lax',
        secure: isHttps,
        maxAge: 30 * 24 * 60 * 60 * 1000,
      });
      return res.redirect('/');
    } catch (err) {
      console.error('[auth] Twitch callback error:', err);
      return res.redirect(`/?auth_error=${encodeURIComponent(err.message)}`);
    }
  });

  app.post('/auth/logout', (req, res) => {
    if (req.cookies.kacky_session) {
      db.deleteSession(req.cookies.kacky_session);
    }
    res.clearCookie('kacky_session');
    res.json({ ok: true });
  });

  // --- API Routes ---
  app.get('/api/me', (req, res) => {
    res.json({
      twitchConfigured: twitchService.isConfigured(),
      redirectUri:
        options.twitchRedirectUri ??
        process.env.TWITCH_REDIRECT_URI ??
        `${baseUrl}/auth/twitch/callback`,
      user: sanitizeUser(req.user),
    });
  });

  app.put('/api/settings', requireAuth, (req, res) => {
    const updated = db.updateUserSettings(req.user.twitch_user_id, {
      twitchChatEnabled: req.body?.twitchChatEnabled ?? true,
      wizebotEnabled: req.body?.wizebotEnabled ?? false,
      wizebotApiKey: req.body?.wizebotApiKey ?? '',
      alarmSeconds: req.body?.alarmSeconds ?? 60,
      messageTemplate: req.body?.messageTemplate ?? DEFAULT_MESSAGE_TEMPLATE,
    });
    res.json({ user: sanitizeUser(updated) });
  });

  app.post('/api/test-alarm', requireAuth, async (req, res) => {
    const user = req.user;
    const testMessage =
      String(req.body?.message || '').trim() ||
      `ALARMBLUE KackyAlarm connected! Alarms will be posted to #${user.twitch_login} (${user.alarm_seconds || 60}s before map start). ALARMBLUE`;

    const results = [];

    if (user.twitch_chat_enabled) {
      try {
        await twitchService.sendChatMessage(user, testMessage);
        db.insertAlarmLog({
          twitchUserId: user.twitch_user_id,
          eventId: kackyClient.getState().activeEvent?.id || 0,
          serverLogin: 'test',
          serverName: 'Test Ping',
          mapNumber: 0,
          mapUid: '',
          dedupeKey: `test:${user.twitch_user_id}:${Date.now()}:twitch`,
          channelLogin: user.twitch_login,
          provider: 'twitch',
          status: 'sent',
          message: testMessage,
          errorDetail: '',
          triggeredAt: Date.now(),
        });
        results.push({ provider: 'twitch', status: 'sent' });
      } catch (err) {
        results.push({ provider: 'twitch', status: 'error', error: err.message });
      }
    }

    if (user.wizebot_enabled && user.wizebot_api_key) {
      try {
        await sendWizebotCustomEvent(user.wizebot_api_key, {
          event: 'kacky_alarm_test',
          channel: user.twitch_login,
          message: testMessage,
        });
        db.insertAlarmLog({
          twitchUserId: user.twitch_user_id,
          eventId: kackyClient.getState().activeEvent?.id || 0,
          serverLogin: 'test',
          serverName: 'Test Ping',
          mapNumber: 0,
          mapUid: '',
          dedupeKey: `test:${user.twitch_user_id}:${Date.now()}:wizebot`,
          channelLogin: user.twitch_login,
          provider: 'wizebot',
          status: 'sent',
          message: testMessage,
          errorDetail: '',
          triggeredAt: Date.now(),
        });
        results.push({ provider: 'wizebot', status: 'sent' });
      } catch (err) {
        results.push({ provider: 'wizebot', status: 'error', error: err.message });
      }
    }

    if (results.length === 0) {
      return res.status(400).json({
        error: 'No delivery provider enabled. Enable Twitch Chat or WizeBot in Settings.',
      });
    }

    const anyError = results.find((r) => r.status === 'error');
    if (anyError && results.every((r) => r.status === 'error')) {
      return res.status(502).json({ error: anyError.error, results });
    }
    return res.json({ ok: true, results });
  });

  app.get('/api/live', (req, res) => {
    const kacky = kackyClient.getState();
    const eventId = kacky.activeEvent?.id ?? kacky.servers[0]?.eventId ?? null;

    const alarmsMap = {};
    let hasServerAlarms = false;
    let recentLogs = [];
    let alertedMaps = [];
    if (req.user && eventId) {
      const rows = db.getMapAlarmsForUser(req.user.twitch_user_id, eventId);
      hasServerAlarms = rows.length > 0;
      for (const row of rows) {
        alarmsMap[row.map_number] = Boolean(row.enabled);
      }
      recentLogs = db.getAlarmLogsForUser(req.user.twitch_user_id, 30);
      alertedMaps = db.getRecentAlertedMapsForUser(req.user.twitch_user_id);
    }

    res.json({
      servers: kacky.servers,
      lastServersSyncAt: kacky.lastServersSyncAt,
      lastServersError: kacky.lastServersError,
      activeEvent: kacky.activeEvent,
      maps: kacky.maps,
      lastMapsSyncAt: kacky.lastMapsSyncAt,
      lastMapsError: kacky.lastMapsError,
      alarms: alarmsMap,
      hasServerAlarms,
      recentLogs,
      alertedMaps,
      serverTime: Date.now(),
    });
  });

  app.post('/api/refresh', async (req, res) => {
    const refreshMaps = Boolean(req.body?.includeMaps);
    await kackyClient.refreshServers();
    if (refreshMaps) {
      await kackyClient.refreshActiveEventAndMaps();
    }
    res.json({ ok: true, serverTime: Date.now() });
  });

  app.put('/api/alarms/bulk', requireAuth, (req, res) => {
    const kacky = kackyClient.getState();
    const eventId = Number(req.body?.eventId ?? kacky.activeEvent?.id);
    const enabled = Boolean(req.body?.enabled);
    const mapNumbers = Array.isArray(req.body?.mapNumbers)
      ? req.body.mapNumbers.map(Number).filter((n) => Number.isFinite(n))
      : [];

    if (!eventId || mapNumbers.length === 0) {
      return res.status(400).json({ error: 'Valid eventId and mapNumbers are required.' });
    }

    const byNumber = new Map(kacky.maps.map((m) => [m.mapNumber, m]));
    const targets = mapNumbers.map((num) => {
      const m = byNumber.get(num);
      return {
        mapNumber: num,
        mapUid: m?.mapUid || '',
        name: m?.name || `#${num}`,
      };
    });

    db.setBulkMapAlarms(req.user.twitch_user_id, eventId, targets, enabled);
    return res.json({ ok: true, count: targets.length, enabled });
  });

  app.put('/api/alarms/:mapNumber', requireAuth, (req, res) => {
    const kacky = kackyClient.getState();
    const mapNumber = Number(req.params.mapNumber);
    const eventId = Number(req.body?.eventId ?? kacky.activeEvent?.id);
    const enabled = Boolean(req.body?.enabled);

    if (!Number.isFinite(mapNumber) || !eventId) {
      return res.status(400).json({ error: 'Valid mapNumber and eventId are required.' });
    }

    const found = kacky.maps.find((m) => m.mapNumber === mapNumber);
    db.setMapAlarm(
      req.user.twitch_user_id,
      eventId,
      mapNumber,
      enabled,
      found?.mapUid || '',
      found?.name || `#${mapNumber}`
    );

    return res.json({ ok: true, eventId, mapNumber, enabled });
  });

  app.get('/api/logs', requireAuth, (req, res) => {
    const logs = db.getAlarmLogsForUser(req.user.twitch_user_id, 50);
    res.json({ logs });
  });

  app.get('/api/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const client = {
      res,
      userId: req.user?.twitch_user_id || null,
    };
    sseClients.add(client);

    const kacky = kackyClient.getState();
    res.write(
      `event: servers\ndata: ${JSON.stringify({
        servers: kacky.servers,
        lastServersSyncAt: kacky.lastServersSyncAt,
        lastServersError: kacky.lastServersError,
        serverTime: Date.now(),
      })}\n\n`
    );

    const heartbeat = setInterval(() => {
      res.write(': ping\n\n');
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(client);
    });
  });

  app.use(express.static(path.join(__dirname, 'public')));

  return {
    app,
    db,
    kackyClient,
    twitchService,
    alarmEngine,
    async start() {
      await kackyClient.start();
      alarmEngine.start(1000);
      return new Promise((resolve) => {
        const server = app.listen(port, host, () => {
          console.log(`KackyAlarm running at ${baseUrl} (listening on ${host}:${port})`);
          resolve(server);
        });
      });
    },
    stop() {
      alarmEngine.stop();
      kackyClient.stop();
      db.close();
    },
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const instance = createApp();
  instance.start().catch((err) => {
    console.error('Failed to start KackyAlarm:', err);
    process.exit(1);
  });
}
