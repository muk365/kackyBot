/**
 * Optional WizeBot Custom Event integration.
 * Allows pushing Kacky alarm events to WizeBot (https://panel.wizebot.tv/)
 * via POST https://wapi.wizebot.tv/api/custom-events/{API_KEY}/send
 */
export async function sendWizebotCustomEvent(apiKey, payload) {
  const cleanKey = String(apiKey || '').trim();
  if (!cleanKey) {
    throw new Error('WizeBot API key is missing');
  }

  const url = `https://wapi.wizebot.tv/api/custom-events/${encodeURIComponent(cleanKey)}/send`;
  const form = new URLSearchParams();
  form.set('DATA_JSON', JSON.stringify(payload));

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
    signal: AbortSignal.timeout(10000),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`WizeBot API ${res.status}: ${text.slice(0, 200)}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
