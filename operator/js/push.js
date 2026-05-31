'use strict';

/*
 * Web Push client for the operator PWA. Wraps permission + subscription flow:
 *   status()  → { supported, permission, subscribed }
 *   enable()  → request permission, subscribe, register sub with the server
 *   disable() → unsubscribe locally + forget on the server
 *   test()    → ask the server to push a test notification to this device
 * The VAPID public key is fetched from the server (authenticated). Depends on
 * GC.api for the authenticated fetch wrapper.
 */

window.GC = window.GC || {};

(function (GC) {
  const { api } = GC;

  function supported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }

  // VAPID keys are base64url; the PushManager wants a Uint8Array.
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function registration() {
    return navigator.serviceWorker.ready;
  }

  async function currentSubscription() {
    if (!supported()) return null;
    const reg = await registration();
    return reg.pushManager.getSubscription();
  }

  async function status() {
    if (!supported()) return { supported: false, permission: 'unsupported', subscribed: false };
    const sub = await currentSubscription().catch(() => null);
    return { supported: true, permission: Notification.permission, subscribed: !!sub };
  }

  async function enable() {
    if (!supported()) throw new Error('This browser does not support notifications.');

    const { configured, publicKey } = await api.apiFetch('/api/operator/push/key');
    if (!configured || !publicKey) throw new Error('Push is not set up on the server yet.');

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('Notifications were not allowed for this site.');

    const reg = await registration();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }
    await api.apiFetch('/api/operator/push/subscribe', {
      method: 'POST',
      body: JSON.stringify({ subscription: sub.toJSON ? sub.toJSON() : sub }),
    });
    return true;
  }

  async function disable() {
    const sub = await currentSubscription().catch(() => null);
    if (sub) await sub.unsubscribe().catch(() => {});
    await api.apiFetch('/api/operator/push/unsubscribe', { method: 'POST' }).catch(() => {});
  }

  function test() {
    return api.apiFetch('/api/operator/push/test', { method: 'POST' });
  }

  GC.push = { supported, status, enable, disable, test };
})(window.GC);
