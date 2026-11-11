// Computes the shipped file list and a content hash, then rewrites the VERSION and FILES lines in
// sw.js and the VERSION line in src/version.js (PLAN.md §6). `node tools/build-precache.mjs [root]`
//
// Shipped = index.html, manifest.webmanifest, sw.js, css/**, icons/*.png, icons/icon.svg and
// src/**/*.js, EXCLUDING dev-only pages and their scripts: any src/**/*.html, and src/**/demo*.js,
// src/**/test*.js, src/**/*.test.js, src/**/*.spec.js, and anything under a src/**/demo/ or
// src/**/test(s)/ folder.
//
// listShippedFiles(root) is exported so a deploy script copies exactly the same files.
// The precache list in sw.js is the shipped list minus sw.js itself. The version hash covers
// every shipped file except sw.js and src/version.js (which it rewrites), so it only changes when
// real content changes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HASH_EXCLUDE = new Set(['sw.js', 'src/version.js']);

/** @param {string} dir @param {string} root @returns {string[]} repo-relative POSIX paths */
function walk(dir, root) {
  /** @type {string[]} */
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(full, root));
    else if (ent.isFile()) out.push(path.relative(root, full).split(path.sep).join('/'));
  }
  return out;
}

/** @param {string} rel src-relative path @returns {boolean} */
function isDevOnlySrc(rel) {
  const parts = rel.split('/');
  const base = parts[parts.length - 1];
  if (base.endsWith('.html')) return true;
  if (/^(demo|test)/i.test(base)) return true;
  if (/\.(test|spec)\.js$/i.test(base)) return true;
  if (parts.slice(0, -1).some((p) => /^(demo|demos|test|tests)$/i.test(p))) return true;
  return false;
}

/**
 * The files that make up the shipped app, sorted, as POSIX paths relative to `root`.
 * @param {string} [root]
 * @returns {string[]}
 */
export function listShippedFiles(root = DEFAULT_ROOT) {
  /** @type {string[]} */
  const files = [];
  for (const f of ['index.html', 'manifest.webmanifest', 'sw.js']) {
    if (fs.existsSync(path.join(root, f))) files.push(f);
  }
  files.push(...walk(path.join(root, 'css'), root));
  for (const f of walk(path.join(root, 'icons'), root)) {
    const base = f.slice('icons/'.length);
    if (!base.includes('/') && (base.endsWith('.png') || base === 'icon.svg')) files.push(f);
  }
  for (const f of walk(path.join(root, 'src'), root)) {
    const rel = f.slice('src/'.length);
    if (f.endsWith('.js') && !isDevOnlySrc(rel)) files.push(f);
  }
  return [...new Set(files)].sort();
}

/** Files under src/ that are neither shipped nor dev-only pages (e.g. .glsl): worth a warning. */
function unshippedSrc(root, shipped) {
  const set = new Set(shipped);
  return walk(path.join(root, 'src'), root).filter((f) => !set.has(f) && !isDevOnlySrc(f.slice(4)));
}

/** @param {string} root @param {string[]} files */
export function contentHash(root, files) {
  const h = crypto.createHash('sha256');
  for (const f of files) {
    if (HASH_EXCLUDE.has(f)) continue;
    h.update(f); h.update('\0');
    h.update(fs.readFileSync(path.join(root, f))); h.update('\0');
  }
  return h.digest('hex');
}

/**
 * Rewrite sw.js and src/version.js. Returns { version, files }.
 * @param {string} [root]
 */
export function buildPrecache(root = DEFAULT_ROOT) {
  const shipped = listShippedFiles(root);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const version = `${pkg.version || '0.0.0'}+${contentHash(root, shipped).slice(0, 8)}`;
  const precache = shipped.filter((f) => f !== 'sw.js');

  const swPath = path.join(root, 'sw.js');
  let sw = fs.readFileSync(swPath, 'utf8');
  const vRe = /^const VERSION = .*;$/m;
  const fRe = /^const FILES = .*;$/m;
  if (!vRe.test(sw) || !fRe.test(sw)) throw new Error('sw.js: VERSION / FILES lines not found');
  sw = sw.replace(vRe, `const VERSION = ${JSON.stringify(version)};`)
    .replace(fRe, `const FILES = ${JSON.stringify(precache)};`);
  fs.writeFileSync(swPath, sw);

  const verPath = path.join(root, 'src', 'version.js');
  let ver = fs.readFileSync(verPath, 'utf8');
  const evRe = /^export const VERSION = .*;$/m;
  if (!evRe.test(ver)) throw new Error('src/version.js: VERSION line not found');
  ver = ver.replace(evRe, `export const VERSION = ${JSON.stringify(version)};`);
  fs.writeFileSync(verPath, ver);

  return { version, files: precache, warnings: unshippedSrc(root, shipped) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] ?? DEFAULT_ROOT);
  const { version, files, warnings } = buildPrecache(root);
  const bytes = files.reduce((n, f) => n + fs.statSync(path.join(root, f)).size, 0);
  console.log(`version ${version}`);
  console.log(`${files.length} files precached (${(bytes / 1024).toFixed(1)} KiB):`);
  for (const f of files) console.log(`  ${f}`);
  if (warnings.length) {
    console.log('\nWARNING: files under src/ that are not shipped (not .js, or not dev-only):');
    for (const w of warnings) console.log(`  ${w}`);
  }
}
