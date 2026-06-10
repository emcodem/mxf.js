/**
 * Decode N frames and write raw yuv422p to C:/temp/decoded.yuv
 * View with: ffplay -f rawvideo -pix_fmt yuv422p -video_size 1920x1080 -framerate 25 -i C:/temp/decoded.yuv
 */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import fs from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

// We need to run through tsx/ts-node to import TypeScript modules.
// Instead, use vitest's node runner via a companion test file.
console.log('Run via: npx vitest run scripts/dump-yuv.test.ts');
console.log('Then: ffplay -f rawvideo -pix_fmt yuv422p -video_size 1920x1080 -framerate 25 -i C:/temp/decoded.yuv');
