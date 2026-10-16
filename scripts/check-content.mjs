import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const allowedRoot = new Set(['README.md', 'package.json', 'package-lock.json', 'tsconfig.json', '.gitignore', '.gitattributes', '.nvmrc']);
const directories = new Set(['src', 'tests', 'examples', 'docs', 'assets', 'scripts', 'reference']);
const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/,
  /(?:postgres(?:ql)?|mongodb(?:\+srv)?):\/\//i,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
  /[A-Za-z]:[\\/](?:Users|codex|home)[\\/]/i,
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
];
let count = 0;
function visit(dir, relative = '') {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (relative === '' && ['.git', 'node_modules'].includes(entry.name)) continue;
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    const path = resolve(dir, entry.name);
    if (entry.isSymbolicLink()) throw Error(`Symlink is not allowed: ${name}`);
    if (entry.isDirectory()) {
      if (!directories.has(name)) throw Error(`Unexpected directory: ${name}`);
      visit(path, name);
      continue;
    }
    if ((!relative && !allowedRoot.has(name)) || (relative && !/\.(?:ts|md|svg|mjs)$/.test(name))) throw Error(`Unexpected file: ${name}`);
    const text = readFileSync(path, 'utf8');
    // The scanner contains token signatures as patterns, not credentials.
    // Lockfile includes public registry metadata, package maintainers and integrity hashes.
    if (name !== 'scripts/check-content.mjs' && name !== 'package-lock.json') {
      for (const pattern of patterns) if (pattern.test(text)) throw Error(`Sensitive pattern in ${name}: ${pattern.source}`);
    }
    if (name.endsWith('.md')) {
      for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
        const link = match[1];
        if (/^(?:https?:|#)/.test(link)) continue;
        const target = resolve(dirname(path), link.split('#')[0]);
        if (!target.startsWith(root)) throw Error(`Link outside repository: ${name}`);
        readFileSync(target);
      }
    }
    count++;
  }
}
visit(root);
console.log(`Public content checks passed: ${count} files; local Markdown links resolve.`);
console.log('Pattern checks and allowlists supplement manual review; they do not prove absence of all sensitive information.');
