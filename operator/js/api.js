'use strict';

/*
 * API client for the operator PWA.
 *
 * Token storage: access + refresh tokens live in localStorage. The access
 * token is short-lived (15m); when a request comes back 401 with
 * code "token_expired", we transparently use the refresh token to mint a new
 * pair and retry once. If refresh fails, we clear tokens and the app falls
 * back to the login screen.
 */

window.GC = window.GC || {};

(function (GC) {
  const ACCESS_KEY = 'gc.accessToken';
  const REFRESH_KEY = 'gc.refreshToken';
  const USER_KEY = 'gc.user';

  const auth = {
    get access() { return localStorage.getItem(ACCESS_KEY); },
    get refresh() { return localStorage.getItem(REFRESH_KEY); },
    get user() {
      try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); }
      catch { return null; }
    },
    isLoggedIn() { return !!this.access && !!this.refresh; },
    save({ accessToken, refreshToken, user }) {
      if (accessToken) localStorage.setItem(ACCESS_KEY, accessToken);
      if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
      if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
    },
    clear() {
      localStorage.removeItem(ACCESS_KEY);
      localStorage.removeItem(REFRESH_KEY);
      localStorage.removeItem(USER_KEY);
    },
  };

  // Raised when authentication can't be recovered; the app shows login.
  class AuthError extends Error {}

  async function login(email, password) {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Login failed');
    }
    auth.save(data);
    return data.user;
  }

  // Attempt to refresh the access token. Returns true on success.
  async function refresh() {
    if (!auth.refresh) return false;
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: auth.refresh }),
    });
    if (!res.ok) return false;
    const data = await res.json().catch(() => null);
    if (!data || !data.accessToken) return false;
    auth.save(data);
    return true;
  }

  // Authenticated fetch against the JSON API. Adds the bearer token, parses
  // JSON, and retries once after a transparent token refresh on 401.
  async function apiFetch(path, options = {}, _retried = false) {
    const headers = Object.assign({}, options.headers);
    if (auth.access) headers.Authorization = `Bearer ${auth.access}`;
    if (options.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(path, Object.assign({}, options, { headers }));

    if (res.status === 401 && !_retried) {
      const refreshed = await refresh();
      if (refreshed) return apiFetch(path, options, true);
      auth.clear();
      throw new AuthError('Session expired');
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401) { auth.clear(); throw new AuthError(data.error || 'Unauthorized'); }
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return data;
  }

  function logout() {
    auth.clear();
  }

  GC.api = { auth, login, logout, refresh, apiFetch, AuthError };
})(window.GC);
