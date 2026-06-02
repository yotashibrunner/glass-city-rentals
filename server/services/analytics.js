'use strict';

// Marketing analytics tags (GA4 + Meta/Facebook Pixel), emitted only when the
// matching env var is set — silent otherwise. The head markup is computed once
// at boot (config is constant) and injected into every page <head> via
// app.locals, plus the static marketing homepage.

const config = require('../config');

// GA/Pixel IDs are alphanumeric + dash; strip anything else so they're safe to
// interpolate into inline script.
function safeId(id) {
  return String(id || '').replace(/[^A-Za-z0-9_-]/g, '');
}

const GA_ID = safeId(config.googleAnalyticsId);
const PIXEL_ID = safeId(config.facebookPixelId);

function gaTags() {
  if (!GA_ID) return '';
  return `
<script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', '${GA_ID}');
</script>`;
}

function pixelTags() {
  if (!PIXEL_ID) return '';
  return `
<script>
  !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
  n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
  n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
  t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
  document,'script','https://connect.facebook.net/en_US/fbevents.js');
  fbq('init','${PIXEL_ID}');
  fbq('track','PageView');
</script>
<noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=${PIXEL_ID}&ev=PageView&noscript=1"/></noscript>`;
}

// Combined <head> tags (GA + Pixel). Empty string when neither is configured.
function headTags() {
  return `${gaTags()}${pixelTags()}`;
}

// A Meta Pixel Purchase event for the confirmation page (fired once a booking is
// paid). Empty string when the Pixel isn't configured.
function purchaseTag(valueCents, currency = 'USD') {
  if (!PIXEL_ID) return '';
  const value = (Math.max(0, Number(valueCents) || 0) / 100).toFixed(2);
  return `
<script>
  if (window.fbq) fbq('track','Purchase',{value:${value},currency:'${currency}'});
</script>`;
}

module.exports = { headTags, purchaseTag, GA_ID, PIXEL_ID };
