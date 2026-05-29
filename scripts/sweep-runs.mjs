#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  parseArgs
} from './lib/project.mjs';
import {
  ACTIVE_RUN_STATUSES,
  readRuns,
  resolveResultPathFromRun,
  updateRun,
  writeRunIndex
} from './lib/runs.mjs';

const root = process.cwd();
const args = parseArgs();

function runPmCommand(commandArgs) {
  return spawnSync('npm', commandArgs, {
    cwd: root,
    stdio: 'pipe',
    encoding: 'utf8',
    shell: process.platform === 'win32'
  });
}

function recoveredStatus(run) {
  if (run.status !== 'collect-failed') return run.status;
  if (run.exit_code === 0) return 'completed';
  return 'failed';
}

const runs = readRuns(root);
const active = runs.filter((run) => ACTIVE_RUN_STATUSES.includes(run.status));
const candidates = runs.filter((run) => !ACTIVE_RUN_STATUSES.includes(run.status));

const summary = {
  schema_version: 'pm-sweep-summary.v1',
  inspected: runs.length,
  active_skipped: active.length,
  candidates: candidates.length,
  collect_status: null,
  reconcile_status: null,
  runs_updated: 0,
  errors: []
};

if (candidates.length > 0) {
  const collect = runPmCommand(['run', 'collect']);
  summary.collect_status = collect.status;
  if (collect.status !== 0) {
    summary.errors.push(collect.stderr || collect.stdout || 'npm run collect failed');
  }

  const reconcile = runPmCommand(['run', 'reconcile']);
  summary.reconcile_status = reconcile.status;
  if (reconcile.status !== 0) {
    summary.errors.push(reconcile.stderr || reconcile.stdout || 'npm run reconcile failed');
  }

  if (collect.status === 0 && reconcile.status === 0) {
    for (const run of candidates) {
      const resultPath = resolveResultPathFromRun(root, run);
      const patch = {
        result_path: resultPath
      };
      if (run.status === 'collect-failed') patch.status = recoveredStatus(run);
      const shouldUpdate = run.result_path !== resultPath || patch.status;
      if (!shouldUpdate) continue;
      updateRun(root, run.run_id, patch);
      summary.runs_updated += 1;
    }
    writeRunIndex(root);
  }
}

if (args.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`sweep complete: inspected=${summary.inspected}, active_skipped=${summary.active_skipped}, candidates=${summary.candidates}, runs_updated=${summary.runs_updated}`);
  if (summary.collect_status !== null) console.log(`collect_status=${summary.collect_status}`);
  if (summary.reconcile_status !== null) console.log(`reconcile_status=${summary.reconcile_status}`);
  for (const error of summary.errors) console.error(`error - ${String(error).trim()}`);
}

if (summary.errors.length > 0) process.exit(1);
