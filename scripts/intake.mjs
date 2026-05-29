#!/usr/bin/env node
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  parseArgs,
  pathExists,
  runChecked
} from './lib/project.mjs';
import { discoverEmployees } from './lib/protocol.mjs';
import {
  appendPmEvent,
  reconcileLedger,
  writeLedger
} from './lib/ledger.mjs';
import {
  loadTask,
  prepareDispatch,
  selectEmployee,
  writeDispatch
} from './lib/dispatch.mjs';
import {
  buildRun,
  writeRun,
  writeRunIndex
} from './lib/runs.mjs';

const root = process.cwd();
const args = parseArgs();

function usage() {
  console.error('usage: npm run intake -- --file tasks/drafts/task-0004.json [--employee junior-demo] [--dry-run] [--no-launch] [--force] [--interactive] [--background] [--timeout-minutes 60]');
}

function appendEvent(type, dispatch, message, data = {}) {
  appendPmEvent(root, {
    type,
    task_id: dispatch?.task?.task_id || '',
    employee_id: dispatch?.employee?.employee_id || '',
    decision: '',
    message,
    data
  });
}

function ensureDispatchWouldNotOverwrite(dispatch) {
  if (pathExists(dispatch.employeeTaskPath) && !args.force) {
    throw new Error(`employee task already exists: ${dispatch.employeeTaskRelativePath}; pass --force to overwrite`);
  }
  if (pathExists(dispatch.submittedPath) && !args.force) {
    throw new Error(`submission record already exists: ${dispatch.submittedRelativePath}; pass --force to overwrite`);
  }
}

function buildWorkerCommand(run) {
  return `${process.execPath} ${path.join('scripts', 'run-worker.mjs')} --run-id ${run.run_id}`;
}

if (!args.file) {
  usage();
  process.exit(1);
}

try {
  const { task, taskPath } = loadTask(root, args.file);
  const index = discoverEmployees(root, { writeIndex: !args['dry-run'] });
  const employee = selectEmployee(root, index, task, args.employee || '');
  const interactive = Boolean(args.interactive);
  const background = Boolean(args.background);
  if (background && interactive) {
    throw new Error('--background cannot be combined with --interactive');
  }
  if (background && args['no-launch']) {
    throw new Error('--background cannot be combined with --no-launch');
  }
  const dispatch = prepareDispatch(root, taskPath, task, employee, {
    autoRun: !interactive,
    includePrompt: interactive,
    skipPermissions: Boolean(args['skip-permissions'])
  });
  const run = background ? buildRun(root, dispatch, {
    timeoutMinutes: args['timeout-minutes']
  }) : null;

  ensureDispatchWouldNotOverwrite(dispatch);

  if (args['dry-run']) {
    console.log(`dry-run intake for ${task.task_id}`);
    console.log(`selected employee: ${employee.alias} (${employee.employee_id})`);
    console.log(`employee task: ${dispatch.employeeTaskRelativePath}`);
    console.log(`submitted record: ${dispatch.submittedRelativePath}`);
    console.log(`profile: ${dispatch.profile}`);
    console.log(`mode: ${background ? 'background' : (interactive ? 'interactive' : 'auto-run')}`);
    if (background) {
      console.log(`run id: ${run.run_id}`);
      console.log(`run file: state/runs/${run.run_id}.json`);
      console.log(`run log: ${run.log_path}`);
      console.log(`timeout minutes: ${run.timeout_minutes}`);
      console.log('worker command:');
      console.log(buildWorkerCommand(run));
    }
    console.log('launch command:');
    console.log(dispatch.launchCommand);
    console.log('dry-run only; no files were written and employee was not launched');
    process.exit(0);
  }

  appendEvent('intake_started', dispatch, `intake started for ${task.task_id}`, {
    task_file: args.file
  });
  appendEvent('employee_selected', dispatch, `selected ${employee.alias}`, {
    employee_alias: employee.alias,
    employee_path: employee.path,
    profile: dispatch.profile,
    mode: background ? 'background' : (interactive ? 'interactive' : 'auto-run')
  });

  writeDispatch(root, dispatch, { force: Boolean(args.force) });
  appendEvent('task_submitted', dispatch, `submitted ${task.task_id} to ${employee.alias}`, {
    employee_task_path: dispatch.employeeTaskRelativePath,
    submitted_path: dispatch.submittedRelativePath
  });

  writeLedger(root, reconcileLedger(root));
  console.log(`intake submitted ${task.task_id} to ${employee.alias}`);
  console.log(`employee task: ${dispatch.employeeTaskRelativePath}`);
  console.log(`mode: ${background ? 'background' : (interactive ? 'interactive' : 'auto-run')}`);

  if (args['no-launch']) {
    console.log('no-launch requested; employee was not launched');
    process.exit(0);
  }

  if (background) {
    writeRun(root, run);
    writeRunIndex(root);
    appendEvent('run_created', dispatch, `created background run ${run.run_id}`, {
      run_id: run.run_id,
      run_file: `state/runs/${run.run_id}.json`,
      log_path: run.log_path,
      timeout_minutes: run.timeout_minutes
    });

    const worker = spawn(process.execPath, ['scripts/run-worker.mjs', '--run-id', run.run_id], {
      cwd: root,
      detached: true,
      stdio: 'ignore',
      shell: process.platform === 'win32'
    });
    worker.unref();
    console.log(`background run: ${run.run_id}`);
    console.log(`log: ${run.log_path}`);
    console.log(`worker pid: ${worker.pid}`);
    console.log('use npm run runs to inspect run status');
    process.exit(0);
  }

  appendEvent('employee_launched', dispatch, `launching ${employee.alias}`, {
    launch_command: dispatch.launchCommand,
    mode: interactive ? 'interactive' : 'auto-run'
  });

  console.log('launch command:');
  console.log(dispatch.launchCommand);
  console.log('');

  const result = spawnSync('npm', dispatch.launchArgs, {
    cwd: path.join(root, employee.path),
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });

  appendEvent('employee_exited', dispatch, `employee exited with status ${result.status ?? ''}`, {
    status: result.status,
    signal: result.signal || null
  });

  if (result.status !== 0) {
    console.error(`error - employee exited with status ${result.status}`);
    console.error(`check employee logs under ${employee.path}/logs`);
    process.exit(result.status || 1);
  }

  runChecked('npm', ['run', 'collect'], { cwd: root });
  runChecked('npm', ['run', 'reconcile'], { cwd: root });
} catch (error) {
  console.error(`error - ${error.message}`);
  process.exit(1);
}
