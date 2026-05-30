import fs from 'node:fs';
import path from 'node:path';
import {
  ensureDir,
  nowIso,
  pathExists,
  readJson,
  safeFileName,
  writeJson
} from './project.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_MS = 100;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockDir(root, name) {
  return path.join(root, 'state/locks', `${safeFileName(name)}.lock`);
}

function lockInfoPath(root, name) {
  return path.join(lockDir(root, name), 'lock.json');
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function readLockInfo(root, name) {
  const infoPath = lockInfoPath(root, name);
  if (!pathExists(infoPath)) return null;
  try {
    return readJson(infoPath);
  } catch {
    return null;
  }
}

function removeLock(root, name) {
  fs.rmSync(lockDir(root, name), { recursive: true, force: true });
}

export function acquireLock(root, name, metadata = {}, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const startedAt = Date.now();
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const dirPath = lockDir(root, name);
  ensureDir(path.dirname(dirPath));

  while (true) {
    try {
      fs.mkdirSync(dirPath);
      writeJson(lockInfoPath(root, name), {
        schema_version: 'pm-lock.v1',
        name,
        token,
        pid: process.pid,
        created_at: nowIso(),
        metadata
      });
      return { name, token, path: dirPath };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }

    const info = readLockInfo(root, name);
    if (!info || !isPidAlive(Number(info.pid))) {
      removeLock(root, name);
      continue;
    }

    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`lock ${name} is held by pid ${info.pid}; try again later`);
    }
    sleep(pollMs);
  }
}

export function releaseLock(root, lock) {
  if (!lock) return;
  const info = readLockInfo(root, lock.name);
  if (!info || info.token !== lock.token) return;
  removeLock(root, lock.name);
}

export function withLock(root, name, metadata, fn, options = {}) {
  const lock = acquireLock(root, name, metadata, options);
  try {
    return fn();
  } finally {
    releaseLock(root, lock);
  }
}
