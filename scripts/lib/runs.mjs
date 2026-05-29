import fs from 'node:fs';
import path from 'node:path';
import {
  ensureDir,
  nowIso,
  pathExists,
  printTable,
  readJson,
  relativeFrom,
  safeFileName,
  writeJson
} from './project.mjs';

export const RUN_SCHEMA = 'pm-run.v1';
export const RUN_INDEX_SCHEMA = 'pm-runs-index.v1';
export const RUN_STATUSES = ['starting', 'running', 'completed', 'failed', 'timed-out', 'collect-failed'];
export const ACTIVE_RUN_STATUSES = ['starting', 'running'];

export function runsDir(root) {
  return path.join(root, 'state/runs');
}

export function runFilePath(root, runId) {
  return path.join(runsDir(root), `${safeFileName(runId)}.json`);
}

export function listRunFiles(root) {
  const dir = runsDir(root);
  if (!pathExists(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(dir, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

export function readRuns(root) {
  return listRunFiles(root).map((filePath) => readJson(filePath));
}

export function writeRun(root, run) {
  ensureDir(runsDir(root));
  writeJson(runFilePath(root, run.run_id), run);
}

export function updateRun(root, runId, patch) {
  const filePath = runFilePath(root, runId);
  if (!pathExists(filePath)) throw new Error(`run not found: ${runId}`);
  const run = {
    ...readJson(filePath),
    ...patch,
    updated_at: nowIso()
  };
  writeRun(root, run);
  return run;
}

export function writeRunIndex(root) {
  const runs = readRuns(root)
    .sort((a, b) => String(a.started_at || '').localeCompare(String(b.started_at || '')));
  const index = {
    schema_version: RUN_INDEX_SCHEMA,
    updated_at: nowIso(),
    runs
  };
  writeJson(path.join(root, 'state/runs.json'), index);
  return index;
}

export function activeRuns(root) {
  return readRuns(root).filter((run) => ACTIVE_RUN_STATUSES.includes(run.status));
}

export function activeRunForEmployee(root, employeeId) {
  return activeRuns(root).find((run) => run.employee_id === employeeId);
}

export function ensureEmployeeHasNoActiveRun(root, employee) {
  const active = activeRunForEmployee(root, employee.employee_id);
  if (active) {
    throw new Error(`${employee.alias || employee.employee_id} already has active run ${active.run_id} (${active.status})`);
  }
}

export function createRunId(employeeId, taskId) {
  const stamp = new Date().toISOString()
    .replaceAll(':', '')
    .replaceAll('.', '')
    .replace('T', '-')
    .replace('Z', '');
  return `${safeFileName(employeeId)}__${safeFileName(taskId)}__${stamp}`;
}

export function normalizeTimeoutMinutes(value) {
  if (value === undefined || value === null || value === true || value === '') return 60;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error('--timeout-minutes must be a non-negative number');
  }
  return parsed;
}

export function buildRun(root, dispatch, options = {}) {
  const runId = options.runId || createRunId(dispatch.employee.employee_id, dispatch.task.task_id);
  const logPath = path.join('logs/runs', `${safeFileName(runId)}.log`);
  return {
    schema_version: RUN_SCHEMA,
    run_id: runId,
    task_id: dispatch.task.task_id,
    employee_id: dispatch.employee.employee_id,
    employee_alias: dispatch.employee.alias,
    employee_path: dispatch.employee.path,
    status: 'starting',
    pid: null,
    worker_pid: null,
    started_at: nowIso(),
    updated_at: nowIso(),
    ended_at: '',
    exit_code: null,
    signal: null,
    timeout_minutes: normalizeTimeoutMinutes(options.timeoutMinutes),
    log_path: logPath,
    submitted_path: dispatch.submittedRelativePath,
    result_path: '',
    launch_args: dispatch.launchArgs,
    launch_command: dispatch.launchCommand,
    profile: dispatch.profile
  };
}

export function resolveResultPathFromRun(root, run) {
  const resultPath = path.join(
    root,
    'results/collected',
    safeFileName(run.employee_id),
    `${safeFileName(run.task_id)}.json`
  );
  return pathExists(resultPath) ? relativeFrom(root, resultPath) : '';
}

export function printRunsTable(runs) {
  printTable(runs.map((run) => ({
    run_id: run.run_id,
    employee: run.employee_alias || run.employee_id,
    task_id: run.task_id,
    status: run.status,
    pid: run.pid || '',
    exit_code: run.exit_code ?? '',
    started_at: run.started_at || '',
    ended_at: run.ended_at || '',
    log_path: run.log_path || ''
  })), [
    { key: 'run_id', header: 'run_id' },
    { key: 'employee', header: 'employee' },
    { key: 'task_id', header: 'task_id' },
    { key: 'status', header: 'status' },
    { key: 'pid', header: 'pid' },
    { key: 'exit_code', header: 'exit_code' },
    { key: 'started_at', header: 'started_at' },
    { key: 'ended_at', header: 'ended_at' },
    { key: 'log_path', header: 'log_path' }
  ]);
}
