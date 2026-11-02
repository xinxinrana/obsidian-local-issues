import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
const license = await readFile('LICENSE', 'utf8');
const notices = await readFile('THIRD_PARTY_NOTICES.txt', 'utf8');
const editor = await build({ entryPoints: ['src/markdown-editor.ts'], bundle: true, write: false, format: 'iife', globalName: 'LocalIssuesMarkdown', footer: { js: 'window.LocalIssuesMarkdown = LocalIssuesMarkdown;' }, platform: 'browser', target: 'es2022', minify: true, legalComments: 'inline' });
await writeFile('src/markdown-editor-bundle.json', JSON.stringify({ script: editor.outputFiles[0].text }) + '\n');
await build({ entryPoints: ['src/main.ts'], bundle: true, outfile: 'main.js', format: 'cjs', platform: 'browser', target: 'es2022', external: ['obsidian', 'electron', 'node:*'], sourcemap: false, minify: true, legalComments: 'inline', banner: { js: `/*!\n${license}\n${notices}\n*/` }, logLevel: 'info' });
await build({ entryPoints: ['src/cli.ts'], bundle: true, outfile: 'cli.mjs', format: 'esm', platform: 'node', target: 'node22', sourcemap: false, banner: { js: `/*!\n${license}\n*/` }, logLevel: 'info' });
