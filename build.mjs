import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
const license = await readFile('LICENSE', 'utf8');
const notices = await readFile('THIRD_PARTY_NOTICES.txt', 'utf8');
await build({ entryPoints: ['src/main.ts'], bundle: true, outfile: 'main.js', format: 'cjs', platform: 'node', target: 'es2022', external: ['obsidian', 'electron'], sourcemap: false, minify: true, legalComments: 'inline', banner: { js: `/*!\n${license}\n${notices}\n*/` }, logLevel: 'info' });
await build({ entryPoints: ['src/cli.ts'], bundle: true, outfile: 'cli.mjs', format: 'esm', platform: 'node', target: 'node22', sourcemap: false, banner: { js: `/*!\n${license}\n*/` }, logLevel: 'info' });
