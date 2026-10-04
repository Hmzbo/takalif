// Rasterize public/icon.svg into the PNG sizes the install prompt needs.
//
// Chrome on Android requires 192px and 512px PNGs; `purpose: maskable` needs
// extra padding so nothing important is cropped by the mask. Run with
// `pnpm --filter @takalif/web icons` after editing icon.svg. The PNGs are
// committed so installs and CI never need to run this.
import sharp from 'sharp';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const svg = join(dir, 'icon.svg');

async function png(name, size, { maskable = false } = {}) {
  let pipeline = sharp(svg, { density: 512 });
  if (maskable) {
    // Center the artwork on a full-bleed background with a 10% safe zone.
    const art = await pipeline.resize(410, 410).png().toBuffer();
    pipeline = sharp({
      create: { width: 512, height: 512, channels: 4, background: '#0e7c5b' },
    }).composite([{ input: art, left: 51, top: 51 }]);
  } else {
    pipeline = pipeline.resize(size, size);
  }
  await pipeline.png().toFile(join(dir, name));
  console.log(`wrote public/${name}`);
}

await png('icon-192.png', 192);
await png('icon-512.png', 512);
await png('maskable-512.png', 512, { maskable: true });
