'use strict';

// Generates a VAPID keypair for Web Push and prints it as env-var lines. Run
// once; paste the output into Railway's variables (and your local .env).
//
//   npm run generate-vapid
//
// VAPID keys identify this server to push services (FCM, Mozilla, Apple). The
// public key is shipped to the browser; the private key stays on the server and
// must be kept secret. Rotating them invalidates existing subscriptions.

const webpush = require('web-push');

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

console.log('# Web Push VAPID keys — add these to your environment:\n');
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log('VAPID_SUBJECT=mailto:owner@glasscitytrailerrentals.com');
console.log('\n# The public key is safe to expose; keep the private key secret.');
