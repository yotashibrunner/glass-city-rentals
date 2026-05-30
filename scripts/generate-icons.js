'use strict';

// Generates the operator PWA icons from the marketing logo.
//
//   node scripts/generate-icons.js
//
// Produces three PNGs in operator/icons/:
//   icon-192.png  — Android home screen / manifest
//   icon-512.png  — Android splash / install prompt
//   icon-180.png  — iOS apple-touch-icon
//
// The logo is centered on a solid square background (PWA icons must be square
// and look best with a little padding so the maskable safe-zone isn't clipped).

const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const SRC = path.join(__dirname, '..', 'public', 'images', 'logo.png');
const OUT_DIR = path.join(__dirname, '..', 'operator', 'icons');

// Matches the PWA theme/background color in manifest.json.
const BG = { r: 15, g: 17, b: 21, alpha: 1 };

// Each icon: output size, and the fraction of that size the logo occupies
// (leaving padding so maskable icons aren't cropped by the OS mask).
const ICONS = [
  { size: 192, name: 'icon-192.png', pad: 0.8 },
  { size: 512, name: 'icon-512.png', pad: 0.8 },
  { size: 180, name: 'icon-180.png', pad: 0.82 },
];

async function main() {
  if (!fs.existsSync(SRC)) {
    throw new Error(`Source logo not found at ${SRC}`);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const { size, name, pad } of ICONS) {
    const inner = Math.round(size * pad);
    const logo = await sharp(SRC)
      .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .toBuffer();

    await sharp({
      create: { width: size, height: size, channels: 4, background: BG },
    })
      .composite([{ input: logo, gravity: 'center' }])
      .png()
      .toFile(path.join(OUT_DIR, name));

    console.log(`  ✓ ${name} (${size}×${size})`);
  }

  console.log(`Generated ${ICONS.length} icons in operator/icons/`);
}

main().catch((err) => {
  console.error('Icon generation failed:', err);
  process.exit(1);
});
