const TWITCH_AUTH_BASE = 'https://id.twitch.tv/oauth2';
const TWITCH_HELIX_BASE = 'https://api.twitch.tv/helix';

export function createTwitchService({ clientId, clientSecret, redirectUri, db }) {
  function isConfigured() {
    return Boolean(clientId && clientSecret && redirectUri);
  }

  function getAuthorizeUrl(state) {
    if (!isConfigured()) {
      throw new Error('Twitch OAuth is not configured (missing TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET)');
    }
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'user:write:chat',
      state,
    });
    return `${TWITCH_AUTH_BASE}/authorize?${params.toString()}`;
  }

  async function exchangeCode(code) {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    });

    const res = await fetch(`${TWITCH_AUTH_BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(10000),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.message || `Twitch token exchange failed (${res.status})`);
    }
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || '',
      expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
    };
  }

  async function refreshAccessToken(user) {
    if (!user.refresh_token) {
      throw new Error('No Twitch refresh token available. Please log in with Twitch again.');
    }
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: user.refresh_token,
    });

    const res = await fetch(`${TWITCH_AUTH_BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.message || `Twitch token refresh failed (${res.status})`);
    }

    const accessToken = data.access_token;
    const refreshToken = data.refresh_token || user.refresh_token;
    const expiresAt = Date.now() + Number(data.expires_in || 3600) * 1000;
    db.updateUserTokens(user.twitch_user_id, accessToken, refreshToken, expiresAt);
    return { accessToken, refreshToken, expiresAt };
  }

  async function fetchCurrentUser(accessToken) {
    const res = await fetch(`${TWITCH_HELIX_BASE}/users`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Client-Id': clientId,
      },
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    if (!res.ok || !data?.data?.[0]) {
      throw new Error(data.message || `Failed to fetch Twitch user (${res.status})`);
    }
    const u = data.data[0];
    return {
      twitchUserId: u.id,
      twitchLogin: u.login,
      displayName: u.display_name || u.login,
      profileImageUrl: u.profile_image_url || '',
    };
  }

  async function postHelixChat(accessToken, userId, message) {
    const res = await fetch(`${TWITCH_HELIX_BASE}/chat/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Client-Id': clientId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        broadcaster_id: userId,
        sender_id: userId,
        message: String(message).slice(0, 500),
      }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }

  /**
   * Send a chat message into the logged-in user's own Twitch channel.
   * Automatically refreshes expired OAuth tokens.
   * @param {object} user - Row from `users` table
   * @param {string} message
   */
  async function sendChatMessage(user, message) {
    if (!isConfigured()) {
      throw new Error('Twitch OAuth credentials are not configured on the server.');
    }
    if (!user.access_token) {
      throw new Error('User has no Twitch access token. Please log in with Twitch.');
    }

    let token = user.access_token;
    const fiveMinutes = 5 * 60 * 1000;
    if (user.token_expires_at && Date.now() >= user.token_expires_at - fiveMinutes) {
      const refreshed = await refreshAccessToken(user);
      token = refreshed.accessToken;
    }

    let { res, data } = await postHelixChat(token, user.twitch_user_id, message);

    if (res.status === 401 && user.refresh_token) {
      const refreshed = await refreshAccessToken(user);
      token = refreshed.accessToken;
      ({ res, data } = await postHelixChat(token, user.twitch_user_id, message));
    }

    if (!res.ok) {
      throw new Error(data.message || `Twitch chat API error (${res.status})`);
    }

    const result = data?.data?.[0];
    if (result && result.is_sent === false) {
      const reason = result.drop_reason?.message || result.drop_reason?.code || 'Message dropped by Twitch';
      throw new Error(reason);
    }

    return result || { is_sent: true };
  }

  return {
    isConfigured,
    getAuthorizeUrl,
    exchangeCode,
    refreshAccessToken,
    fetchCurrentUser,
    sendChatMessage,
  };
}
