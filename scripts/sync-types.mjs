#!/usr/bin/env node
/**
 * sync-types: copies the firmware repo's HID protocol type declarations into
 * this project.
 *
 * Source (single source of truth, normative):
 *   <firmware repo>/docs/hid/timegrapher_hid.d.ts
 * Destination:
 *   src/protocol/timegrapher_hid.d.ts
 *
 * The file is kept as a `.d.ts`: it consists of interfaces/type aliases plus
 * `export declare const` ambient constants (no runtime values), so it can only
 * be imported with `import type { ... }`. Runtime constants (report id, chunk
 * size, ...) live in `src/protocol/constants.ts`.
 *
 * Usage:
 *   npm run sync-types                         # default sibling checkout
 *   TIMEGRAPHER_FW_DIR=/path/to/fw npm run sync-types
 *   node scripts/sync-types.mjs /path/to/fw
 *
 * Default firmware location: ../timegrapher-stand (sibling directory).
 */
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fwDir = resolve(
  process.argv[2] ?? process.env.TIMEGRAPHER_FW_DIR ?? resolve(root, '../timegrapher-stand'),
);
const src = resolve(fwDir, 'docs/hid/timegrapher_hid.d.ts');
const dst = resolve(root, 'src/protocol/timegrapher_hid.d.ts');

try {
  await stat(src);
} catch {
  console.error(
    `sync-types: cannot find ${src}\nSet TIMEGRAPHER_FW_DIR or pass the firmware repo path.`,
  );
  process.exit(1);
}

const [a, b] = await Promise.all([readFile(src, 'utf8'), readFile(dst, 'utf8').catch(() => null)]);
await mkdir(dirname(dst), { recursive: true });
if (a === b) {
  console.log('sync-types: already up to date');
} else {
  await copyFile(src, dst);
  console.log(`sync-types: ${src} -> ${dst}`);
}
