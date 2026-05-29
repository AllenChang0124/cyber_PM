import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export function toPosix(value) {
  return value.replaceAll(path.sep, '/');
}

export function nowIso() {
  return new Date().toISOString();
}

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

export function writeText(filePath, text) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, text);
}

export function readJson(filePath) {
  return JSON.parse(readText(filePath));
}

export function writeJson(filePath, value) {
  writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function pathExists(filePath) {
  return fs.existsSync(filePath);
}

export function relativeFrom(root, targetPath) {
  return toPosix(path.relative(root, targetPath));
}

export function isSafeRelativePath(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  if (path.isAbsolute(value)) return false;
  const normalized = toPosix(path.normalize(value));
  if (normalized === '..' || normalized.startsWith('../')) return false;
  return true;
}

export function safeFileName(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_');
}

export function sha256Text(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      if (!args._) args._ = [];
      args._.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    const value = (!next || next.startsWith('--')) ? true : next;
    if (Object.hasOwn(args, key)) {
      args[key] = Array.isArray(args[key]) ? [...args[key], value] : [args[key], value];
    } else {
      args[key] = value;
    }
    if (value !== true) index += 1;
  }
  return args;
}

export function commandAvailable(command, args = ['--version']) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return result.status === 0;
}

export function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.stdio || 'inherit',
    cwd: options.cwd || process.cwd(),
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}`);
  }
  return result;
}

export function printTable(rows, columns) {
  if (rows.length === 0) {
    console.log('(empty)');
    return;
  }

  const widths = columns.map((column) => {
    const values = [column.header, ...rows.map((row) => String(row[column.key] ?? ''))];
    return Math.max(...values.map((value) => value.length));
  });

  const format = (row) => columns
    .map((column, index) => String(row[column.key] ?? '').padEnd(widths[index]))
    .join('  ');

  console.log(format(Object.fromEntries(columns.map((column) => [column.key, column.header]))));
  console.log(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const row of rows) console.log(format(row));
}
