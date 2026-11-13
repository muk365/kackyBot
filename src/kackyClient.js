import { extractServerNumber, stripTmCodes } from './tmFormat.js';

const KACKY_API_BASE = 'https://api.kacky.gg';
const USER_AGENT = 'KackyAlarm/1.0 (+http://localhost)';

/**
 * Normalize a single server entry from /v1/servers/live.
 * @param {object} s
 */
export function normalizeServer(s) {
  const serverNumber = extractServerNumber(s.name);
  return {
    login: s.login,
    name: s.name,
    serverNumber,
    status: s.status,
    playerCount: Number(s.playerCount ?? 0),
    gameType: s.gameType || 'TRACKMANIA',
    eventId: s.eventId ?? null,
    eventType: s.eventType || '',
    eventFamily: s.eventFamily || '',
    currentMap: s.currentMap
      ? {
          mapUid: s.currentMap.mapUid || '',
          rawName: s.currentMap.name || '',
          name: stripTmCodes(s.currentMap.name) || `#${s.currentMap.mapNumber}`,
          mapNumber: Number(s.currentMap.mapNumber),
        }
      : null,
    nextMap: s.nextMap
      ? {
          mapUid: s.nextMap.mapUid || '',
          rawName: s.nextMap.name || '',
          name: stripTmCodes(s.nextMap.name) || `#${s.nextMap.mapNumber}`,
          mapNumber: Number(s.nextMap.mapNumber),
        }
      : null,
    mapStartedAt: s.mapStartedAt || null,
    mapEndsAt: s.mapEndsAt || null,
    isPublicJoin: Boolean(s.isPublicJoin),
  };
}

/**
 * Normalize a map entry from /v1/events/{id}/maps.
 * @param {object} m
 * @param {number} eventId
 */
export function normalizeMap(m, eventId) {
  return {
    mapId: m.mapId,
    mapUid: m.mapUid || '',
    eventId: Number(eventId),
    mapNumber: Number(m.mapNumber),
    rawName: m.mapName || '',
    name: stripTmCodes(m.mapName) || `#${m.mapNumber}`,
    author: m.author || '',
    authorNickname: stripTmCodes(m.authorNickname) || m.authorNickname || 'Unknown',
    authorTime: m.authorTime ?? null,
    wrTime: m.wrTime ?? null,
    recordHolder: stripTmCodes(m.recordHolder) || null,
    totalFinishers: Number(m.totalFinishers ?? 0),
    tier: m.tier ?? null,
    gameType: m.gameType || 'TRACKMANIA',
  };
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    throw new Error(`Kacky API ${res.status} ${res.statusText} for ${url}`);
  }
  return res.json();
}

export function createKackyClient({
  pollIntervalMs = 15000,
  mapsRefreshIntervalMs = 5 * 60 * 1000,
  onServersUpdate = null,
} = {}) {
  const state = {
    servers: [],
    lastServersSyncAt: null,
    lastServersError: null,
    activeEvent: null,
    maps: [],
    lastMapsSyncAt: null,
    lastMapsError: null,
  };

  let serversTimer = null;
  let mapsTimer = null;
  let pollingServers = false;
  let pollingMaps = false;

  async function refreshServers() {
    if (pollingServers) return state.servers;
    pollingServers = true;
    try {
      const raw = await fetchJson(`${KACKY_API_BASE}/v1/servers/live`);
      const normalized = Array.isArray(raw)
        ? raw.map(normalizeServer).sort((a, b) => a.serverNumber - b.serverNumber)
        : [];
      state.servers = normalized;
      state.lastServersSyncAt = Date.now();
      state.lastServersError = null;
      if (onServersUpdate) onServersUpdate(state);
      return state.servers;
    } catch (err) {
      state.lastServersError = err.message;
      console.error('[kackyClient] Failed to fetch live servers:', err.message);
      return state.servers;
    } finally {
      pollingServers = false;
    }
  }

  async function fetchEventMaps(eventId) {
    const allMaps = [];
    const limit = 100;
    let offset = 0;
    let total = Infinity;

    while (offset < total) {
      const page = await fetchJson(
        `${KACKY_API_BASE}/v1/events/${eventId}/maps?Limit=${limit}&Offset=${offset}`
      );
      const rows = Array.isArray(page?.data) ? page.data : [];
      for (const m of rows) {
        allMaps.push(normalizeMap(m, eventId));
      }
      total = Number(page?.meta?.total ?? rows.length);
      if (rows.length === 0 || rows.length < limit) break;
      offset += limit;
    }

    allMaps.sort((a, b) => a.mapNumber - b.mapNumber);
    return allMaps;
  }

  async function refreshActiveEventAndMaps() {
    if (pollingMaps) return { event: state.activeEvent, maps: state.maps };
    pollingMaps = true;
    try {
      let ev = null;
      try {
        ev = await fetchJson(`${KACKY_API_BASE}/v1/events/active`);
      } catch {
        // Fallback to latest event from /v1/events
        const list = await fetchJson(`${KACKY_API_BASE}/v1/events?Limit=5`);
        ev = Array.isArray(list?.data) ? list.data[0] : null;
      }

      if (ev && ev.id) {
        state.activeEvent = {
          id: ev.id,
          edition: ev.edition,
          rawName: ev.name || '',
          name: stripTmCodes(ev.name) || `Event #${ev.id}`,
          eventType: ev.eventType || '',
          startTime: ev.startTime || null,
          endTime: ev.endTime || null,
          isActive: Boolean(ev.isActive),
        };
        state.maps = await fetchEventMaps(ev.id);
        state.lastMapsSyncAt = Date.now();
        state.lastMapsError = null;
      }
      return { event: state.activeEvent, maps: state.maps };
    } catch (err) {
      state.lastMapsError = err.message;
      console.error('[kackyClient] Failed to fetch active event/maps:', err.message);
      return { event: state.activeEvent, maps: state.maps };
    } finally {
      pollingMaps = false;
    }
  }

  async function start() {
    await Promise.all([refreshServers(), refreshActiveEventAndMaps()]);
    serversTimer = setInterval(refreshServers, pollIntervalMs);
    mapsTimer = setInterval(refreshActiveEventAndMaps, mapsRefreshIntervalMs);
  }

  function stop() {
    if (serversTimer) clearInterval(serversTimer);
    if (mapsTimer) clearInterval(mapsTimer);
    serversTimer = null;
    mapsTimer = null;
  }

  return {
    start,
    stop,
    refreshServers,
    refreshActiveEventAndMaps,
    getState() {
      return state;
    },
  };
}
