import sharp from 'sharp';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../../design/brand/ConText-lockup-crimson.png', import.meta.url));
const publicDir = fileURLToPath(new URL('../public/brand/', import.meta.url));
const appDir = fileURLToPath(new URL('../app/', import.meta.url));
const sharedDir = fileURLToPath(new URL('../../packages/workspace-ui/assets/', import.meta.url));
await mkdir(publicDir, { recursive: true });

// The selected crimson master is a full-width 2120 × 742 lockup.
// Keep the symbol separate from the start of the wordmark at x ≈ 710.
const logo = await sharp(source).toBuffer();
const symbol = await sharp(source).extract({ left: 0, top: 0, width: 700, height: 742 }).toBuffer();
const exportPng = (input, size, inset = 0) => sharp(input)
  .resize(size - inset * 2, size - inset * 2, { fit: 'contain', background: '#FFFFFF' })
  .extend({ top: inset, bottom: inset, left: inset, right: inset, background: '#FFFFFF' })
  .ensureAlpha()
  .png({ compressionLevel: 9 }).toBuffer();

await sharp(logo).resize(1200, 420, { fit: 'contain', background: '#FFFFFF' })
  .png({ compressionLevel: 9 }).toFile(`${publicDir}/context-logo.png`);
await writeFile(`${publicDir}/context-symbol.png`, await exportPng(symbol, 512, 16));
await writeFile(`${appDir}/icon.png`, await exportPng(symbol, 512, 16));
await writeFile(`${appDir}/apple-icon.png`, await exportPng(symbol, 180, 14));

// ICO directory followed by lossless PNG frames (supported by modern browsers).
const sizes = [16, 32, 48, 64, 256];
const frames = await Promise.all(sizes.map(size => exportPng(symbol, size, size >= 48 ? 2 : 0)));
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
frames.forEach((frame, index) => {
  const entry = 6 + index * 16;
  header[entry] = sizes[index] === 256 ? 0 : sizes[index];
  header[entry + 1] = header[entry];
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(frame.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += frame.length;
});
await writeFile(`${appDir}/favicon.ico`, Buffer.concat([header, ...frames]));
await Promise.all(['context-logo.png', 'context-symbol.png'].map(name => copyFile(`${publicDir}/${name}`, `${sharedDir}/${name}`)));
console.log('ConText: crimson logo, symbol, app icons and favicon exported for web and desktop.');
