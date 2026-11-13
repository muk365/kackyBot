import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  stripTmCodes,
  formatTmTime,
  extractServerNumber,
  formatAlarmMessage,
} from '../src/tmFormat.js';
import { createDatabase } from '../src/db.js';
import { normalizeServer, normalizeMap } from '../src/kackyClient.js';
import { createAlarmEngine } from '../src/alarmEngine.js';

function createTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kackyalarm-test-'));
  const dbPath = path.join(dir, 'test.sqlite');
  const db = createDatabase(dbPath);
  return {
    db,
    cleanup() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('tmFormat utilities', () => {
  it('strips Trackmania color and formatting codes cleanly', () => {
    assert.equal(
      stripTmCodes('$o$i$aa0Kack$05ay Re$09alo$6a0ad$aa0ed $4f0#497'),
      'Kacky Reloaded #497'
    );
    assert.equal(stripTmCodes('$4EDシ$3EE $1FES$0FFe$0FFa$5FFl$AFF.$FFF_'), 'シ Seal._');
    assert.equal(stripTmCodes('$$100 Map'), '$100 Map');
  });

  it('formats Trackmania times in ms', () => {
    assert.equal(formatTmTime(88212), '1:28.212');
    assert.equal(formatTmTime(20225), '20.225');
    assert.equal(formatTmTime(null), '—');
  });

  it('extracts trailing server numbers for natural sorting', () => {
    const names = [
      'Kacky Reloaded 7 - Server 1',
      'Kacky Reloaded 7 - Server 10',
      'Kacky Reloaded 7 - Server 2',
    ];
    names.sort((a, b) => extractServerNumber(a) - extractServerNumber(b));
    assert.deepEqual(names, [
      'Kacky Reloaded 7 - Server 1',
      'Kacky Reloaded 7 - Server 2',
      'Kacky Reloaded 7 - Server 10',
    ]);
  });

  it('formats alarm message template variables', () => {
    const msg = formatAlarmMessage(
      'Map #{mapNumber} on S{serverNumber} in {seconds}s (after #{currentMapNumber})',
      {
        mapNumber: 499,
        mapName: 'Kacky Reloaded #499',
        serverName: 'Kacky Reloaded 7 - Server 1',
        serverNumber: 1,
        seconds: 59,
        currentMapNumber: 497,
      }
    );
    assert.equal(msg, 'Map #499 on S1 in 59s (after #497)');
  });
});

describe('kackyClient normalizers', () => {
  it('normalizes /v1/servers/live server payload', () => {
    const s = normalizeServer({
      login: 'abc',
      name: 'Kacky Reloaded 7 - Server 10',
      status: 'RUNNING',
      playerCount: 3,
      eventId: 26,
      currentMap: { mapUid: 'u1', name: '$o$4f0#496', mapNumber: 496 },
      nextMap: { mapUid: 'u2', name: '$o$4f0#498', mapNumber: 498 },
      mapStartedAt: '2026-11-13T08:08:41.931Z',
      mapEndsAt: '2026-11-13T08:26:56.931Z',
      isPublicJoin: true,
    });
    assert.equal(s.serverNumber, 10);
    assert.equal(s.currentMap.name, '#496');
    assert.equal(s.nextMap.mapNumber, 498);
  });

  it('normalizes /v1/events/{id}/maps entry', () => {
    const m = normalizeMap(
      {
        mapId: 7846953,
        mapUid: 'uid1',
        mapName: '$o$4f0#451',
        mapNumber: 451,
        authorTime: 106547,
        authorNickname: 'Daduul.Tm',
        wrTime: 88212,
        recordHolder: '$4EDシ$3EE $1FES$0FFe$0FFa$5FFl',
        totalFinishers: 687,
      },
      26
    );
    assert.equal(m.eventId, 26);
    assert.equal(m.name, '#451');
    assert.equal(m.recordHolder, 'シ Seal');
  });
});

describe('alarmEngine 1-minute trigger & deduplication', () => {
  it('fires once when nextMap is armed and <= 60s remaining, and never duplicates the same cycle', async () => {
    const { db, cleanup } = createTempDb();
    try {
      db.upsertUser({
        twitchUserId: '12345',
        twitchLogin: 'streamer_one',
        displayName: 'StreamerOne',
        accessToken: 'tok',
        refreshToken: 'ref',
        tokenExpiresAt: Date.now() + 3600_000,
      });
      db.setMapAlarm('12345', 26, 499, true, 'uid499', 'Kacky Reloaded #499');

      const baseTime = Date.parse('2026-11-13T09:00:00.000Z');
      let mapEndsAt = new Date(baseTime + 75_000).toISOString(); // 75s left

      const kackyClient = {
        getState() {
          return {
            servers: [
              {
                login: 'srv1',
                name: 'Kacky Reloaded 7 - Server 1',
                serverNumber: 1,
                status: 'RUNNING',
                eventId: 26,
                currentMap: { mapNumber: 497, name: 'Kacky Reloaded #497', mapUid: 'u497' },
                nextMap: { mapNumber: 499, name: 'Kacky Reloaded #499', mapUid: 'uid499' },
                mapEndsAt,
              },
            ],
          };
        },
      };

      const sentMessages = [];
      const twitchService = {
        async sendChatMessage(user, message) {
          sentMessages.push({ channel: user.twitch_login, message });
          return { is_sent: true };
        },
      };

      const engine = createAlarmEngine({ db, kackyClient, twitchService });

      // At 75s remaining -> should NOT fire
      let res = await engine.evaluateOnce(baseTime);
      assert.equal(res.length, 0);
      assert.equal(sentMessages.length, 0);

      // Advance to 59s remaining -> SHOULD fire once with ALARMBLUE framing
      res = await engine.evaluateOnce(baseTime + 16_000);
      assert.equal(res.length, 1);
      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0].channel, 'streamer_one');
      assert.ok(sentMessages[0].message.startsWith('ALARMBLUE '));
      assert.ok(sentMessages[0].message.endsWith(' ALARMBLUE'));
      assert.match(sentMessages[0].message, /#499/);
      assert.match(sentMessages[0].message, /59s/);

      // Next second (58s remaining) -> must NOT duplicate
      res = await engine.evaluateOnce(baseTime + 17_000);
      assert.equal(res.length, 0);
      assert.equal(sentMessages.length, 1);

      // Even if mapEndsAt shifts slightly on a kacky.gg refresh -> alerted_maps prevents re-triggering
      mapEndsAt = new Date(baseTime + 77_000).toISOString();
      res = await engine.evaluateOnce(baseTime + 18_000);
      assert.equal(res.length, 0);
      assert.equal(sentMessages.length, 1);

      // New map cycle later with a different mapEndsAt (> 5m later) -> SHOULD fire again
      const laterBase = baseTime + 30 * 60_000;
      mapEndsAt = new Date(laterBase + 45_000).toISOString();
      res = await engine.evaluateOnce(laterBase);
      assert.equal(res.length, 1);
      assert.equal(sentMessages.length, 2);
    } finally {
      cleanup();
    }
  });
});
