#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  ensureDir,
  parseArgs,
  pathExists,
  readJson
} from './lib/project.mjs';
import {
  appendPmEvent,
  reconcileLedger,
  writeLedger
} from './lib/ledger.mjs';
import {
  resolveResultPathFromRun,
  runFilePath,
  updateRun,
  writeRunIndex
} from './lib/runs.mjs';

const root = process.cwd();
const args = parseArgs();

function appendRunEvent(type, run, message, data = {}) {
  appendPmEvent(root, {
    type,
    task_id: run.task_id,
    employee_id: run.employee_id,
    decision: '',
    message,
    data: {
      run_id: run.run_id,
      ...data
    }
  });
}

function appendLog(logPath, text) {
  ensureDir(path.dirname(logPath));
  fs.appendFileSync(logPath, text);
}

function runPmCommand(commandArgs) {
  return spawnSync('npm', commandArgs, {
    cwd: root,
    stdio: 'pipe',
    encoding: 'utf8',
    shell: process.platform === 'win32'
  });
}

if (!args['run-id']) {
  console.error('usage: node scripts/run-worker.mjs --run-id <run_id>');
  process.exit(1);
}

const runPath = runFilePath(root, args['run-id']);
if (!pathExists(runPath)) {
  console.error(`run not found: ${args['run-id']}`);
  process.exit(1);
}

let run = readJson(runPath);
const logPath = path.join(root, run.log_path);

appendLog(logPath, `# PM run worker ${run.run_id}\n`);
appendLog(logPath, `started_at=${new Date().toISOString()}\n`);
appendLog(logPath, `launch_command=${run.launch_command}\n\n`);

const child = spawn('npm', run.launch_args || ['run', 'claude', '--', '--profile', run.profile, '--task', run.task_id, '--auto-run'], {
  cwd: path.join(root, run.employee_path),
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: process.platform === 'win32'
});

run = updateRun(root, run.run_id, {
  status: 'running',
  pid: child.pid,
  worker_pid: process.pid
});
writeRunIndex(root);
appendRunEvent('run_started', run, `run ${run.run_id} started`, {
  pid: child.pid,
  log_path: run.log_path
});

child.stdout.on('data', (chunk) => appendLog(logPath, chunk));
child.stderr.on('data', (chunk) => appendLog(logPath, chunk));

let timedOut = false;
let timeout = null;
if (run.timeout_minutes > 0) {
  timeout = setTimeout(() => {
    timedOut = true;
    appendLog(logPath, `\n[pm-worker] timeout after ${run.timeout_minutes} minute(s); terminating employee process\n`);
    child.kill();
  }, run.timeout_minutes * 60 * 1000);
}

child.on('error', (error) => {
  if (timeout) clearTimeout(timeout);
  appendLog(logPath, `\n[pm-worker] failed to launch employee: ${error.message}\n`);
  run = updateRun(root, run.run_id, {
    status: 'failed',
    ended_at: new Date().toISOString(),
    exit_code: null,
    signal: null
  });
  writeRunIndex(root);
  appendRunEvent('run_failed', run, error.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (timeout) clearTimeout(timeout);

  const status = timedOut ? 'timed-out' : (code === 0 ? 'completed' : 'failed');
  run = updateRun(root, run.run_id, {
    status,
    ended_at: new Date().toISOString(),
    exit_code: code,
    signal: signal || null
  });
  writeRunIndex(root);

  appendLog(logPath, `\n[pm-worker] employee exited status=${code ?? ''} signal=${signal || ''}\n`);
  appendRunEvent(
    timedOut ? 'run_timed_out' : (code === 0 ? 'run_completed' : 'run_failed'),
    run,
    `run ${run.run_id} ${status}`,
    { exit_code: code, signal: signal || null }
  );

  const collect = runPmCommand(['run', 'collect']);
  appendLog(logPath, `\n[pm-worker] npm run collect status=${collect.status}\n`);
  if (collect.stdout) appendLog(logPath, collect.stdout);
  if (collect.stderr) appendLog(logPath, collect.stderr);

  const reconcile = runPmCommand(['run', 'reconcile']);
  appendLog(logPath, `\n[pm-worker] npm run reconcile status=${reconcile.status}\n`);
  if (reconcile.stdout) appendLog(logPath, reconcile.stdout);
  if (reconcile.stderr) appendLog(logPath, reconcile.stderr);

  if (collect.status !== 0 || reconcile.status !== 0) {
    run = updateRun(root, run.run_id, {
      status: 'collect-failed',
      result_path: resolveResultPathFromRun(root, run)
    });
    writeRunIndex(root);
    appendRunEvent('run_collect_failed', run, `run ${run.run_id} collect/reconcile failed`, {
      collect_status: collect.status,
      reconcile_status: reconcile.status
    });
    process.exit(1);
  }

  run = updateRun(root, run.run_id, {
    result_path: resolveResultPathFromRun(root, run)
  });
  writeRunIndex(root);
  process.exit(status === 'completed' ? 0 : 1);
});
