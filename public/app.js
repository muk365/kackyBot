const state = {
  twitchConfigured: false,
  redirectUri: '',
  user: null,
  activeEvent: null,
  servers: [],
  maps: [],
  alarms: {}, // { [mapNumber]: boolean }
  recentLogs: [],
  alertedMaps: [],
  lastServersSyncAt: null,
  lastServersError: null,
  clockOffsetMs: 0,
  filter: 'all',
  search: '',
  zeroRefreshScheduledFor: new Set(),
};

const els = {
  eventBadge: document.getElementById('eventBadge'),
  syncStatus: document.getElementById('syncStatus'),
  refreshBtn: document.getElementById('refreshBtn'),
  authArea: document.getElementById('authArea'),
  alertBanner: document.getElementById('alertBanner'),
  serverCountPill: document.getElementById('serverCountPill'),
  serversList: document.getElementById('serversList'),
  armedCountPill: document.getElementById('armedCountPill'),
  mapSearch: document.getElementById('mapSearch'),
  mapsTableBody: document.getElementById('mapsTableBody'),
  selectFilteredBtn: document.getElementById('selectFilteredBtn'),
  clearFilteredBtn: document.getElementById('clearFilteredBtn'),
  exportAlarmsBtn: document.getElementById('exportAlarmsBtn'),
  importAlarmsBtn: document.getElementById('importAlarmsBtn'),
  logsCountPill: document.getElementById('logsCountPill'),
  logsList: document.getElementById('logsList'),
  testAlarmBtn: document.getElementById('testAlarmBtn'),
  settingsModal: document.getElementById('settingsModal'),
  closeSettingsBtn: document.getElementById('closeSettingsBtn'),
  settingsForm: document.getElementById('settingsForm'),
  alarmSecondsInput: document.getElementById('alarmSecondsInput'),
  messageTemplateInput: document.getElementById('messageTemplateInput'),
  templatePreview: document.getElementById('templatePreview'),
  twitchChatEnabledInput: document.getElementById('twitchChatEnabledInput'),
  wizebotEnabledInput: document.getElementById('wizebotEnabledInput'),
  wizebotApiKeyInput: document.getElementById('wizebotApiKeyInput'),
  modalTestBtn: document.getElementById('modalTestBtn'),
  setupModal: document.getElementById('setupModal'),
  closeSetupBtn: document.getElementById('closeSetupBtn'),
  setupRedirectUri: document.getElementById('setupRedirectUri'),
  copyRedirectBtn: document.getElementById('copyRedirectBtn'),
  toast: document.getElementById('toast'),
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function showToast(message, isError = false) {
  els.toast.textContent = message;
  els.toast.classList.toggle('error', isError);
  els.toast.classList.remove('hidden');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    els.toast.classList.add('hidden');
  }, 4000);
}

function nowSyncedMs() {
  return Date.now() + state.clockOffsetMs;
}

function formatCountdown(ms) {
  if (!Number.isFinite(ms)) return '--:--';
  if (ms <= 0) return 'Changing…';
  const totalSec = Math.ceil(ms / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function formatTmTime(ms) {
  if (ms === null || ms === undefined || Number(ms) <= 0) return '—';
  const totalMs = Math.round(Number(ms));
  const mins = Math.floor(totalMs / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const millis = String(totalMs % 1000).padStart(3, '0');
  if (mins > 0) return `${mins}:${String(secs).padStart(2, '0')}.${millis}`;
  return `${secs}.${millis}`;
}

function formatRelativeTime(ts) {
  if (!ts) return 'never';
  const diffSec = Math.max(0, Math.round((nowSyncedMs() - ts) / 1000));
  if (diffSec < 3) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const mins = Math.floor(diffSec / 60);
  return `${mins}m ago`;
}

function hasSentAlarmForCycle(server) {
  if (!server?.nextMap || !server?.mapEndsAt) return false;
  const endsMs = Date.parse(server.mapEndsAt);
  const nextNum = Number(server.nextMap.mapNumber);

  const inAlertedMaps = state.alertedMaps.some((a) => {
    if (a.server_login !== server.login || Number(a.map_number) !== nextNum) return false;
    if (server.mapStartedAt && a.map_started_at && a.map_started_at === server.mapStartedAt) {
      return true;
    }
    const prevEndsMs = a.map_ends_at ? Date.parse(a.map_ends_at) : NaN;
    return Number.isFinite(prevEndsMs) && Math.abs(prevEndsMs - endsMs) < 5 * 60 * 1000;
  });
  if (inAlertedMaps) return true;

  return state.recentLogs.some(
    (log) =>
      log.server_login === server.login &&
      Number(log.map_number) === nextNum &&
      log.status === 'sent' &&
      Math.abs(log.triggered_at - endsMs) < 10 * 60 * 1000
  );
}

function getAlarmThresholdSeconds() {
  return Number(state.user?.alarmSeconds || 60);
}

function renderAuth() {
  if (state.user) {
    els.authArea.innerHTML = `
      <div class="user-chip">
        ${
          state.user.profileImageUrl
            ? `<img class="user-avatar" src="${escapeHtml(state.user.profileImageUrl)}" alt="" />`
            : `<span class="user-avatar"></span>`
        }
        <div class="user-meta">
          <span class="user-name">${escapeHtml(state.user.displayName)}</span>
          <span class="user-channel">Chat: #${escapeHtml(state.user.twitchLogin)}</span>
        </div>
      </div>
      <button id="openSettingsBtn" class="btn btn-ghost btn-sm">⚙ Settings</button>
      <button id="logoutBtn" class="btn btn-ghost btn-sm">Log out</button>
    `;

    document.getElementById('openSettingsBtn').addEventListener('click', openSettingsModal);
    document.getElementById('logoutBtn').addEventListener('click', logout);
    els.testAlarmBtn.classList.remove('hidden');
  } else if (state.twitchConfigured) {
    els.authArea.innerHTML = `
      <a href="/auth/twitch" class="btn btn-twitch">Login with Twitch</a>
    `;
    els.testAlarmBtn.classList.add('hidden');
  } else {
    els.authArea.innerHTML = `
      <button id="openSetupBtn" class="btn btn-twitch">Setup Twitch Login</button>
    `;
    document.getElementById('openSetupBtn').addEventListener('click', openSetupModal);
    els.testAlarmBtn.classList.add('hidden');
  }

  // Banner when not logged in or OAuth error
  const params = new URLSearchParams(window.location.search);
  const authError = params.get('auth_error');
  if (authError) {
    els.alertBanner.classList.remove('hidden');
    els.alertBanner.innerHTML = `
      <span>Twitch login notice: <strong>${escapeHtml(authError)}</strong></span>
      <button id="dismissBannerBtn" class="btn btn-ghost btn-sm">Dismiss</button>
    `;
    document.getElementById('dismissBannerBtn').addEventListener('click', () => {
      els.alertBanner.classList.add('hidden');
      history.replaceState({}, '', '/');
    });
  } else if (!state.twitchConfigured) {
    els.alertBanner.classList.remove('hidden');
    els.alertBanner.innerHTML = `
      <span>
        Live Kacky server &amp; map data is running. To enable Twitch Login &amp; channel chat alarms,
        add your Twitch App credentials to <code>.env</code>.
      </span>
      <button id="bannerSetupBtn" class="btn btn-ghost btn-sm">View 3-Step Setup</button>
    `;
    document.getElementById('bannerSetupBtn').addEventListener('click', openSetupModal);
  } else if (!state.user) {
    els.alertBanner.classList.remove('hidden');
    els.alertBanner.innerHTML = `
      <span>Log in with Twitch so you can save map alarms and receive 1-minute alerts in your Twitch chat.</span>
      <a href="/auth/twitch" class="btn btn-twitch btn-sm">Login with Twitch</a>
    `;
  } else {
    els.alertBanner.classList.add('hidden');
  }
}

function renderHeaderMeta() {
  if (state.activeEvent) {
    els.eventBadge.textContent = `${state.activeEvent.name} • ${state.maps.length} Maps`;
  } else {
    els.eventBadge.textContent = 'Kacky Live';
  }

  if (state.lastServersError) {
    els.syncStatus.textContent = `Sync error: ${state.lastServersError}`;
    els.syncStatus.classList.add('error');
  } else if (state.lastServersSyncAt) {
    els.syncStatus.textContent = `Synced ${formatRelativeTime(state.lastServersSyncAt)}`;
    els.syncStatus.classList.remove('error');
  }
}

function renderServers() {
  const servers = state.servers || [];
  els.serverCountPill.textContent = `${servers.length} servers`;

  if (servers.length === 0) {
    els.serversList.innerHTML = `<div class="empty-state">No live servers reported right now.</div>`;
    return;
  }

  const now = nowSyncedMs();
  const thresholdMs = getAlarmThresholdSeconds() * 1000;

  els.serversList.innerHTML = servers
    .map((s) => {
      const endsMs = s.mapEndsAt ? Date.parse(s.mapEndsAt) : NaN;
      const remainingMs = Number.isFinite(endsMs) ? endsMs - now : NaN;
      const nextNum = s.nextMap?.mapNumber;
      const nextArmed = Boolean(nextNum && state.alarms[nextNum]);
      const sent = nextArmed && hasSentAlarmForCycle(s);
      const isSoon = nextArmed && Number.isFinite(remainingMs) && remainingMs > 0 && remainingMs <= thresholdMs;

      if (Number.isFinite(remainingMs) && remainingMs <= -2000 && !state.zeroRefreshScheduledFor.has(s.login + s.mapEndsAt)) {
        state.zeroRefreshScheduledFor.add(s.login + s.mapEndsAt);
        setTimeout(() => refreshLiveData(false), 2000);
      }

      let badgeHtml = `<span class="pill pill-muted">${escapeHtml(s.status)}</span>`;
      if (sent) {
        badgeHtml = `<span class="pill pill-sent">✓ Alarm Sent</span>`;
      } else if (isSoon) {
        badgeHtml = `<span class="pill pill-soon">⏰ &lt; ${getAlarmThresholdSeconds()}s!</span>`;
      } else if (nextArmed) {
        badgeHtml = `<span class="pill pill-armed">🔔 Next Armed</span>`;
      }

      const cardClasses = [
        'server-card',
        nextArmed ? 'has-armed-next' : '',
        isSoon ? 'alarm-imminent' : '',
      ]
        .filter(Boolean)
        .join(' ');

      return `
        <article class="${cardClasses}" data-server="${escapeHtml(s.login)}">
          <div class="server-top">
            <div class="server-title">
              <span class="server-num">S${s.serverNumber < 100 ? s.serverNumber : '?'}</span>
              <span>${escapeHtml(s.name)}</span>
            </div>
            <span class="server-players">${s.playerCount} players</span>
          </div>

          <div class="server-maps">
            <div class="map-slot">
              <div class="map-slot-label">Current Map</div>
              <div class="map-slot-num">${s.currentMap ? `#${s.currentMap.mapNumber}` : '—'}</div>
            </div>
            <div class="map-slot ${nextArmed ? 'next-armed' : ''}">
              <div class="map-slot-label">Next Map</div>
              <div class="map-slot-num">${s.nextMap ? `#${s.nextMap.mapNumber}` : '—'}</div>
            </div>
          </div>

          <div class="server-footer">
            <div class="timer-box">
              <span class="timer-label">Next in</span>
              <span
                class="timer-value ${isSoon ? 'soon' : ''}"
                data-ends-at="${escapeHtml(s.mapEndsAt || '')}"
                data-server-login="${escapeHtml(s.login)}"
              >${formatCountdown(remainingMs)}</span>
            </div>
            ${badgeHtml}
          </div>
        </article>
      `;
    })
    .join('');
}

function buildMapServerLookup() {
  const now = nowSyncedMs();
  const mapStatus = new Map(); // mapNumber -> { current: [], next: [] }
  for (const s of state.servers) {
    if (s.currentMap?.mapNumber) {
      const entry = mapStatus.get(s.currentMap.mapNumber) || { current: [], next: [] };
      entry.current.push(s);
      mapStatus.set(s.currentMap.mapNumber, entry);
    }
    if (s.nextMap?.mapNumber) {
      const endsMs = s.mapEndsAt ? Date.parse(s.mapEndsAt) : NaN;
      const remainingMs = Number.isFinite(endsMs) ? endsMs - now : NaN;
      const entry = mapStatus.get(s.nextMap.mapNumber) || { current: [], next: [] };
      entry.next.push({ server: s, remainingMs });
      mapStatus.set(s.nextMap.mapNumber, entry);
    }
  }
  return mapStatus;
}

function getFilteredMaps() {
  const q = state.search.trim().toLowerCase();
  const serverLookup = buildMapServerLookup();

  return state.maps.filter((m) => {
    const armed = Boolean(state.alarms[m.mapNumber]);
    if (state.filter === 'armed' && !armed) return false;
    if (state.filter === 'unarmed' && armed) return false;
    if (state.filter === 'on_servers' && !serverLookup.has(m.mapNumber)) return false;

    if (!q) return true;
    const haystack = [
      `#${m.mapNumber}`,
      String(m.mapNumber),
      m.name,
      m.authorNickname,
      m.recordHolder || '',
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  });
}

function renderMapsTable() {
  const armedCount = Object.values(state.alarms).filter(Boolean).length;
  els.armedCountPill.textContent = `${armedCount} / ${state.maps.length} armed`;

  const filtered = getFilteredMaps();
  if (filtered.length === 0) {
    els.mapsTableBody.innerHTML = `
      <tr>
        <td colspan="6" class="empty-state">No maps match your current filter.</td>
      </tr>
    `;
    return;
  }

  const serverLookup = buildMapServerLookup();

  els.mapsTableBody.innerHTML = filtered
    .map((m) => {
      const armed = Boolean(state.alarms[m.mapNumber]);
      const live = serverLookup.get(m.mapNumber);
      const tags = [];
      if (live) {
        for (const s of live.current) {
          tags.push(`<span class="live-tag live-tag-now">LIVE S${s.serverNumber}</span>`);
        }
        for (const item of live.next) {
          tags.push(
            `<span class="live-tag live-tag-next" data-next-ends-at="${escapeHtml(item.server.mapEndsAt || '')}" data-next-server="${item.server.serverNumber}">NEXT S${item.server.serverNumber} • ${formatCountdown(item.remainingMs)}</span>`
          );
        }
      }

      return `
        <tr class="${armed ? 'row-armed' : ''}" data-map-number="${m.mapNumber}">
          <td>
            <label class="switch" aria-label="Toggle alarm for map #${m.mapNumber}">
              <input
                type="checkbox"
                class="alarm-toggle"
                data-map-number="${m.mapNumber}"
                ${armed ? 'checked' : ''}
              />
              <span class="slider"></span>
            </label>
          </td>
          <td class="map-num-cell">#${m.mapNumber}</td>
          <td>${tags.length ? tags.join('') : '<span class="hint">—</span>'}</td>
          <td>${escapeHtml(m.authorNickname)}</td>
          <td>${m.totalFinishers.toLocaleString()}</td>
          <td class="time-cell">
            <span>WR ${formatTmTime(m.wrTime)}</span>
            ${m.recordHolder ? `<span class="wr-holder">${escapeHtml(m.recordHolder)}</span>` : ''}
          </td>
        </tr>
      `;
    })
    .join('');
}

function renderLogs() {
  if (!state.user) {
    els.logsCountPill.textContent = '0';
    els.logsList.innerHTML = `<div class="empty-state small">Log in with Twitch to see your alarm history.</div>`;
    return;
  }

  els.logsCountPill.textContent = String(state.recentLogs.length);
  if (state.recentLogs.length === 0) {
    els.logsList.innerHTML = `<div class="empty-state small">No alarms triggered yet. Arm a map and wait for it to appear as Next Map!</div>`;
    return;
  }

  els.logsList.innerHTML = state.recentLogs
    .map((log) => {
      const timeStr = new Date(log.triggered_at).toLocaleTimeString();
      const statusClass = log.status === 'sent' ? 'log-status-sent' : 'log-status-error';
      const detail = log.error_detail ? ` (${log.error_detail})` : '';
      return `
        <div class="log-item">
          <span class="log-time">${escapeHtml(timeStr)}</span>
          <span class="pill pill-muted">${escapeHtml(log.provider)}</span>
          <span class="${statusClass}">${escapeHtml(log.status.toUpperCase())}</span>
          <span>#${escapeHtml(log.channel_login)}</span>
          <span class="log-msg">${escapeHtml(log.message)}${escapeHtml(detail)}</span>
        </div>
      `;
    })
    .join('');
}

function tickTimers() {
  const now = nowSyncedMs();
  const thresholdMs = getAlarmThresholdSeconds() * 1000;

  document.querySelectorAll('.timer-value[data-ends-at]').forEach((el) => {
    const endsStr = el.getAttribute('data-ends-at');
    if (!endsStr) return;
    const remainingMs = Date.parse(endsStr) - now;
    el.textContent = formatCountdown(remainingMs);
    const card = el.closest('.server-card');
    const isArmed = card?.classList.contains('has-armed-next');
    const isSoon = isArmed && remainingMs > 0 && remainingMs <= thresholdMs;
    el.classList.toggle('soon', Boolean(isSoon));
    card?.classList.toggle('alarm-imminent', Boolean(isSoon));
  });

  document.querySelectorAll('.live-tag-next[data-next-ends-at]').forEach((el) => {
    const endsStr = el.getAttribute('data-next-ends-at');
    const sNum = el.getAttribute('data-next-server');
    if (!endsStr) return;
    const remainingMs = Date.parse(endsStr) - now;
    el.textContent = `NEXT S${sNum} • ${formatCountdown(remainingMs)}`;
  });

  renderHeaderMeta();
}

const STORAGE_SETTINGS_KEY = 'kackyalarm:v1:settings';

function getAlarmsStorageKey(eventId) {
  return `kackyalarm:v1:alarms:${eventId}`;
}

function getArmedNumbersFromState() {
  return Object.entries(state.alarms)
    .filter(([, enabled]) => Boolean(enabled))
    .map(([num]) => Number(num))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
}

function saveAlarmsToLocal(eventId) {
  if (!eventId) return;
  try {
    const maps = getArmedNumbersFromState();
    localStorage.setItem(
      getAlarmsStorageKey(eventId),
      JSON.stringify({ maps, updatedAt: Date.now() })
    );
  } catch {
    // Ignore storage quota/privacy mode errors
  }
}

function loadAlarmsFromLocal(eventId) {
  if (!eventId) return null;
  try {
    const raw = localStorage.getItem(getAlarmsStorageKey(eventId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.maps)) return null;
    return parsed.maps.map(Number).filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return null;
  }
}

function saveSettingsToLocal(settings) {
  try {
    localStorage.setItem(STORAGE_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage errors
  }
}

function loadSettingsFromLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_SETTINGS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function fetchMe() {
  const res = await fetch('/api/me');
  const data = await res.json();
  state.twitchConfigured = Boolean(data.twitchConfigured);
  state.redirectUri = data.redirectUri || '';
  state.user = data.user || null;

  // Restore saved user settings from browser localStorage if server DB was reset
  if (state.user && !state.user.hasSavedSettings) {
    const savedSettings = loadSettingsFromLocal();
    if (savedSettings) {
      try {
        const restoreRes = await fetch('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(savedSettings),
        });
        if (restoreRes.ok) {
          const restored = await restoreRes.json();
          state.user = restored.user;
        }
      } catch {
        // Ignore transient restore error
      }
    }
  }

  renderAuth();
}

async function fetchLive() {
  const res = await fetch('/api/live');
  const data = await res.json();
  if (data.serverTime) {
    state.clockOffsetMs = data.serverTime - Date.now();
  }
  state.servers = data.servers || [];
  state.lastServersSyncAt = data.lastServersSyncAt;
  state.lastServersError = data.lastServersError;
  state.activeEvent = data.activeEvent || null;
  state.maps = data.maps || [];
  state.alarms = data.alarms || {};
  state.recentLogs = data.recentLogs || [];
  state.alertedMaps = data.alertedMaps || [];

  const eventId = state.activeEvent?.id;
  if (eventId) {
    const localMaps = loadAlarmsFromLocal(eventId);
    if (state.user) {
      if (!data.hasServerAlarms && localMaps && localMaps.length > 0) {
        // Server DB was freshly reset (e.g. Render free restart) — auto-restore from localStorage
        for (const num of localMaps) {
          state.alarms[num] = true;
        }
        try {
          const syncRes = await fetch('/api/alarms/bulk', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              eventId,
              mapNumbers: localMaps,
              enabled: true,
            }),
          });
          if (syncRes.ok) {
            showToast(`Restored ${localMaps.length} armed map(s) from browser memory.`);
          }
        } catch {
          // Will retry on next refresh
        }
      } else if (data.hasServerAlarms) {
        saveAlarmsToLocal(eventId);
      }
    } else if (localMaps && localMaps.length > 0) {
      // Logged out: still display locally saved selections
      for (const num of localMaps) {
        state.alarms[num] = true;
      }
    }
  }

  renderHeaderMeta();
  renderServers();
  renderMapsTable();
  renderLogs();
}

async function refreshLiveData(includeMaps = true) {
  els.refreshBtn.disabled = true;
  try {
    await fetch('/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ includeMaps }),
    });
    await fetchLive();
  } catch (err) {
    showToast(`Refresh failed: ${err.message}`, true);
  } finally {
    els.refreshBtn.disabled = false;
  }
}

async function toggleSingleAlarm(mapNumber, enabled) {
  const previous = Boolean(state.alarms[mapNumber]);
  state.alarms[mapNumber] = enabled;
  saveAlarmsToLocal(state.activeEvent?.id);
  renderServers();

  // Update just the row class without rebuilding the entire table
  const row = els.mapsTableBody.querySelector(`tr[data-map-number="${mapNumber}"]`);
  row?.classList.toggle('row-armed', enabled);
  const armedCount = Object.values(state.alarms).filter(Boolean).length;
  els.armedCountPill.textContent = `${armedCount} / ${state.maps.length} armed`;

  if (!state.user) {
    showToast('Saved locally in browser. Log in with Twitch to receive chat alarms.');
    return;
  }

  try {
    const res = await fetch(`/api/alarms/${mapNumber}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventId: state.activeEvent?.id,
        enabled,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to update alarm');
    }
  } catch (err) {
    state.alarms[mapNumber] = previous;
    saveAlarmsToLocal(state.activeEvent?.id);
    renderMapsTable();
    renderServers();
    showToast(err.message, true);
  }
}

async function bulkToggleFiltered(enabled) {
  const filtered = getFilteredMaps();
  if (filtered.length === 0) return;

  const mapNumbers = filtered.map((m) => m.mapNumber);
  for (const num of mapNumbers) {
    state.alarms[num] = enabled;
  }
  saveAlarmsToLocal(state.activeEvent?.id);
  renderMapsTable();
  renderServers();

  if (!state.user) {
    showToast(
      `${enabled ? 'Armed' : 'Cleared'} ${mapNumbers.length} map(s) locally. Log in with Twitch to send alarms.`
    );
    return;
  }

  try {
    const res = await fetch('/api/alarms/bulk', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventId: state.activeEvent?.id,
        mapNumbers,
        enabled,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Bulk update failed');
    }
    showToast(`${enabled ? 'Armed' : 'Cleared'} ${mapNumbers.length} map(s).`);
  } catch (err) {
    await fetchLive();
    showToast(err.message, true);
  }
}

async function logout() {
  await fetch('/auth/logout', { method: 'POST' });
  state.user = null;
  state.recentLogs = [];
  state.alertedMaps = [];
  renderAuth();
  renderServers();
  renderMapsTable();
  renderLogs();
  showToast('Logged out.');
}

function updateTemplatePreview() {
  const tpl = els.messageTemplateInput.value || '';
  const sample = tpl
    .replaceAll('{mapNumber}', '499')
    .replaceAll('{mapName}', 'Kacky Reloaded #499')
    .replaceAll('{serverName}', 'Kacky Reloaded 7 - Server 1')
    .replaceAll('{serverNumber}', '1')
    .replaceAll('{seconds}', String(els.alarmSecondsInput.value || 60))
    .replaceAll('{currentMapNumber}', '497');
  els.templatePreview.textContent = sample;
}

function openSettingsModal() {
  if (!state.user) return;
  els.alarmSecondsInput.value = state.user.alarmSeconds ?? 60;
  els.messageTemplateInput.value = state.user.messageTemplate || '';
  els.twitchChatEnabledInput.checked = Boolean(state.user.twitchChatEnabled);
  els.wizebotEnabledInput.checked = Boolean(state.user.wizebotEnabled);
  els.wizebotApiKeyInput.value = state.user.wizebotApiKey || '';
  updateTemplatePreview();
  els.settingsModal.classList.remove('hidden');
}

function closeSettingsModal() {
  els.settingsModal.classList.add('hidden');
}

function openSetupModal() {
  els.setupRedirectUri.textContent =
    state.redirectUri || `${window.location.origin}/auth/twitch/callback`;
  els.setupModal.classList.remove('hidden');
}

function closeSetupModal() {
  els.setupModal.classList.add('hidden');
}

async function sendTestMessage() {
  try {
    const res = await fetch('/api/test-alarm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Failed to send test message');
    }
    showToast(`Test message sent to #${state.user.twitchLogin}!`);
    await fetchLive();
  } catch (err) {
    showToast(err.message, true);
  }
}

function connectSse() {
  const es = new EventSource('/api/stream');
  es.addEventListener('servers', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.serverTime) {
        state.clockOffsetMs = data.serverTime - Date.now();
      }
      state.servers = data.servers || [];
      state.lastServersSyncAt = data.lastServersSyncAt;
      state.lastServersError = data.lastServersError;
      renderHeaderMeta();
      renderServers();
      renderMapsTable();
    } catch {
      // Ignore malformed SSE packet
    }
  });

  es.addEventListener('alarm', (ev) => {
    try {
      const entry = JSON.parse(ev.data);
      const srv = state.servers.find((s) => s.login === entry.serverLogin);
      state.alertedMaps = [
        {
          server_login: entry.serverLogin,
          map_number: entry.mapNumber,
          provider: entry.provider,
          map_started_at: srv?.mapStartedAt || '',
          map_ends_at: srv?.mapEndsAt || '',
          alerted_at: entry.triggeredAt,
        },
        ...state.alertedMaps,
      ];
      state.recentLogs = [
        {
          server_login: entry.serverLogin,
          map_number: entry.mapNumber,
          channel_login: entry.channelLogin,
          provider: entry.provider,
          status: entry.status,
          message: entry.message,
          error_detail: entry.errorDetail,
          triggered_at: entry.triggeredAt,
        },
        ...state.recentLogs,
      ].slice(0, 30);
      renderLogs();
      renderServers();
      if (entry.status === 'sent') {
        showToast(`Alarm sent to #${entry.channelLogin}: Map #${entry.mapNumber}`);
      } else {
        showToast(`Alarm failed (${entry.provider}): ${entry.errorDetail}`, true);
      }
    } catch {
      // Ignore malformed SSE packet
    }
  });
}

// Event listeners
els.refreshBtn.addEventListener('click', () => refreshLiveData(true));
els.mapSearch.addEventListener('input', (e) => {
  state.search = e.target.value;
  renderMapsTable();
});

document.querySelectorAll('.filter-group .btn-chip').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-group .btn-chip').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.filter = btn.dataset.filter;
    renderMapsTable();
  });
});

els.mapsTableBody.addEventListener('change', (e) => {
  const input = e.target.closest('.alarm-toggle');
  if (!input) return;
  const mapNumber = Number(input.dataset.mapNumber);
  toggleSingleAlarm(mapNumber, input.checked);
});

els.selectFilteredBtn.addEventListener('click', () => bulkToggleFiltered(true));
els.clearFilteredBtn.addEventListener('click', () => bulkToggleFiltered(false));

els.exportAlarmsBtn.addEventListener('click', async () => {
  const armedNums = Object.entries(state.alarms)
    .filter(([, enabled]) => Boolean(enabled))
    .map(([num]) => Number(num))
    .sort((a, b) => a - b);

  if (armedNums.length === 0) {
    showToast('No armed maps to export.', true);
    return;
  }
  const csv = armedNums.join(',');
  try {
    await navigator.clipboard.writeText(csv);
    showToast(`Copied ${armedNums.length} map(s): ${csv}`);
  } catch {
    window.prompt('Copy your armed map numbers (works in Render DEFAULT_ARMED_MAPS):', csv);
  }
});

els.importAlarmsBtn.addEventListener('click', async () => {
  if (!state.user) {
    showToast('Please log in with Twitch first to import alarms.', true);
    return;
  }
  const raw = window.prompt('Paste map numbers (comma or space separated, e.g. 454,470,499):');
  if (!raw) return;

  const mapNumbers = [...new Set(
    raw
      .split(/[\s,;]+/)
      .map((s) => Number(s.replace(/^#/, '').trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
  )];

  if (mapNumbers.length === 0) {
    showToast('No valid map numbers found.', true);
    return;
  }

  for (const num of mapNumbers) {
    state.alarms[num] = true;
  }
  saveAlarmsToLocal(state.activeEvent?.id);
  renderMapsTable();
  renderServers();

  try {
    const res = await fetch('/api/alarms/bulk', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventId: state.activeEvent?.id,
        mapNumbers,
        enabled: true,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Import failed');
    }
    showToast(`Armed ${mapNumbers.length} imported map(s).`);
  } catch (err) {
    await fetchLive();
    showToast(err.message, true);
  }
});
els.testAlarmBtn.addEventListener('click', sendTestMessage);
els.modalTestBtn.addEventListener('click', sendTestMessage);
els.closeSettingsBtn.addEventListener('click', closeSettingsModal);
els.closeSetupBtn.addEventListener('click', closeSetupModal);

els.settingsModal.addEventListener('click', (e) => {
  if (e.target === els.settingsModal) closeSettingsModal();
});
els.setupModal.addEventListener('click', (e) => {
  if (e.target === els.setupModal) closeSetupModal();
});

els.alarmSecondsInput.addEventListener('input', updateTemplatePreview);
els.messageTemplateInput.addEventListener('input', updateTemplatePreview);
document.querySelectorAll('.chip-var').forEach((chip) => {
  chip.addEventListener('click', () => {
    const v = chip.dataset.var;
    const input = els.messageTemplateInput;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, start) + v + input.value.slice(end);
    input.focus();
    updateTemplatePreview();
  });
});

els.settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    alarmSeconds: Number(els.alarmSecondsInput.value),
    messageTemplate: els.messageTemplateInput.value,
    twitchChatEnabled: els.twitchChatEnabledInput.checked,
    wizebotEnabled: els.wizebotEnabledInput.checked,
    wizebotApiKey: els.wizebotApiKeyInput.value,
  };
  try {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to save settings');
    state.user = data.user;
    saveSettingsToLocal(payload);
    closeSettingsModal();
    renderServers();
    showToast('Settings saved.');
  } catch (err) {
    showToast(err.message, true);
  }
});

els.copyRedirectBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(els.setupRedirectUri.textContent);
    showToast('Redirect URI copied!');
  } catch {
    showToast('Could not copy automatically — please copy manually.', true);
  }
});

// Boot
async function init() {
  await fetchMe();
  await fetchLive();
  connectSse();
  setInterval(tickTimers, 1000);
}

init().catch((err) => {
  console.error('Init failed:', err);
  showToast('Failed to initialize KackyAlarm.', true);
});
