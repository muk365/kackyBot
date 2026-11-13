/**
 * Utilities for formatting Trackmania strings, times, and Kacky server names.
 */

const TM_CODE_REGEX = /\$([0-9a-fA-F]{3}|[lhLH](?:\[[^\]]*\])?|[a-zA-Z<>]|\$)/g;

/**
 * Strip Trackmania color and style formatting codes (e.g. $o, $i, $4f0, $$).
 * @param {string | null | undefined} input
 * @returns {string}
 */
export function stripTmCodes(input) {
  if (!input || typeof input !== 'string') return '';
  return input.replace(TM_CODE_REGEX, (_, code) => (code === '$' ? '$' : '')).trim();
}

/**
 * Format Trackmania time in milliseconds into m:ss.mmm or s.mmm.
 * @param {number | null | undefined} ms
 * @returns {string}
 */
export function formatTmTime(ms) {
  if (ms === null || ms === undefined || Number.isNaN(Number(ms)) || Number(ms) <= 0) {
    return '—';
  }
  const totalMs = Math.round(Number(ms));
  const minutes = Math.floor(totalMs / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const millis = totalMs % 1000;
  const msStr = String(millis).padStart(3, '0');
  if (minutes > 0) {
    return `${minutes}:${String(seconds).padStart(2, '0')}.${msStr}`;
  }
  return `${seconds}.${msStr}`;
}

/**
 * Extract trailing server number for natural sorting (e.g., Server 1..10).
 * @param {string} name
 * @returns {number}
 */
export function extractServerNumber(name) {
  const match = String(name || '').match(/(\d+)\s*$/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

export const DEFAULT_MESSAGE_TEMPLATE =
  'ALARMBLUE Kacky Alarm! Map #{mapNumber} ({mapName}) starts in {seconds}s on {serverName}! ALARMBLUE';

/**
 * Format an alarm message template with map and server variables.
 * @param {string} template
 * @param {object} vars
 * @returns {string}
 */
export function formatAlarmMessage(template, vars) {
  const raw = (template && template.trim()) || DEFAULT_MESSAGE_TEMPLATE;
  const formatted = raw
    .replaceAll('{mapNumber}', String(vars.mapNumber ?? ''))
    .replaceAll('{mapName}', String(vars.mapName ?? ''))
    .replaceAll('{serverName}', String(vars.serverName ?? ''))
    .replaceAll('{serverNumber}', String(vars.serverNumber ?? ''))
    .replaceAll('{seconds}', String(vars.seconds ?? ''))
    .replaceAll('{currentMapNumber}', String(vars.currentMapNumber ?? ''));

  // Twitch chat messages are capped at 500 characters
  return formatted.slice(0, 500);
}
