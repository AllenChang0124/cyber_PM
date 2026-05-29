#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  isSafeRelativePath,
  pathExists,
  readJson,
  readText
} from './lib/project.mjs';
import {
  discoverEmployees,
  requireFields,
  validateResultPackage,
  validateTaskPackage
} from './lib/protocol.mjs';
import {
  LEDGER_SCHEMA,
  PM_EVENT_SCHEMA,
  VALID_PM_DECISIONS
} from './lib/ledger.mjs';
import {
  RUN_INDEX_SCHEMA,
  RUN_SCHEMA,
  RUN_STATUSES
} from './lib/runs.mjs';

const root = process.cwd();
const errors = [];

function fail(message) {
  errors.push(message);
  console.error(`error - ${message}`);
}

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'employees'].includes(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(root, fullPath).replaceAll(path.sep, '/');
    if (entry.isDirectory()) {
      walk(fullPath, files);
    } else {
      files.push(relativePath);
    }
  }
  return files;
}

function validateJsonFile(relativePath, fields) {
  try {
    const value = readJson(path.join(root, relativePath));
    requireFields(value, fields, relativePath, errors);
    return value;
  } catch (error) {
    fail(`${relativePath} is not valid JSON: ${error.message}`);
    return null;
  }
}

const requiredFiles = [
  'package.json',
  'README.md',
  'AGENTS.md',
  'config/employees.json',
  'tasks/drafts/task-0001.example.json'
];
for (const file of requiredFiles) {
  if (!pathExists(path.join(root, file))) fail(`${file} missing`);
}

const requiredDirs = [
  'employees',
  'tasks/drafts',
  'tasks/submitted',
  'results/collected',
  'state',
  'logs',
  'scripts'
];
for (const dir of requiredDirs) {
  if (!pathExists(path.join(root, dir))) fail(`${dir} missing`);
}

const packageJson = validateJsonFile('package.json', ['name', 'version', 'private', 'type', 'scripts']);
for (const scriptName of ['doctor', 'validate', 'setup:demo', 'discover', 'draft', 'intake', 'submit', 'status', 'tasks', 'runs', 'results', 'reconcile', 'resolve', 'collect', 'sweep', 'run-worker']) {
  if (!packageJson?.scripts?.[scriptName]) fail(`package.json missing script: ${scriptName}`);
}

const secretPatterns = [
  { name: 'github token', pattern: /ghp_[A-Za-z0-9_]{20,}/ },
  { name: 'generic api key', pattern: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { name: 's2 token', pattern: /\bs2k-[A-Za-z0-9_-]{16,}/ },
  { name: 'aws access key', pattern: /\bAKIA[A-Z0-9]{16}\b/ }
];

const pathPatterns = [
  { name: 'macOS user home path', pattern: /(^|[^A-Za-z0-9_])\/Users\/[A-Za-z0-9._-]+/ },
  { name: 'Windows user home path', pattern: /\b[A-Za-z]:\/Users\/[A-Za-z0-9._-]+/ },
  { name: 'Claude home dependency', pattern: /~\/\.claude/ },
  { name: 'Codex home dependency', pattern: /~\/\.codex/ }
];

for (const relativePath of walk(root)) {
  if (relativePath === 'scripts/validate.mjs') continue;
  if (relativePath === 'logs/development-handoff.md') continue;
  if (/^\.env(\..+)?$/.test(relativePath) && relativePath !== '.env.example') continue;

  const text = readText(path.join(root, relativePath));
  for (const { name, pattern } of secretPatterns) {
    if (pattern.test(text)) fail(`${relativePath} contains suspected ${name}`);
  }

  const shouldCheckPaths = /\.(mjs|js|json|yaml|yml)$/.test(relativePath);
  if (shouldCheckPaths) {
    for (const { name, pattern } of pathPatterns) {
      if (pattern.test(text)) fail(`${relativePath} contains hard-coded ${name}`);
    }
  }
}

let employeeConfig = null;
try {
  employeeConfig = validateJsonFile('config/employees.json', ['schema_version', 'employees']);
  if (employeeConfig?.schema_version !== 'pm-employees-config.v1') {
    fail('config/employees.json schema_version must be pm-employees-config.v1');
  }
  if (!Array.isArray(employeeConfig?.employees)) fail('config/employees.json employees must be an array');
  for (const [index, employee] of (employeeConfig?.employees || []).entries()) {
    requireFields(employee, ['alias', 'path', 'enabled', 'tags', 'notes'], `config/employees.json employees[${index}]`, errors);
    if (!isSafeRelativePath(employee.path)) fail(`config/employees.json employees[${index}].path must be project-relative`);
    if (employee.path && !employee.path.startsWith('employees/')) fail(`config/employees.json employees[${index}].path must be under employees/`);
  }
} catch (error) {
  fail(`config/employees.json failed validation: ${error.message}`);
}

for (const dir of ['tasks/drafts']) {
  const fullDir = path.join(root, dir);
  if (!pathExists(fullDir)) continue;
  for (const entry of fs.readdirSync(fullDir)) {
    if (!entry.endsWith('.json')) continue;
    const relativePath = `${dir}/${entry}`;
    const task = validateJsonFile(relativePath, []);
    if (task) validateTaskPackage(task, relativePath, errors);
  }
}

const submittedDir = path.join(root, 'tasks/submitted');
if (pathExists(submittedDir)) {
  for (const entry of fs.readdirSync(submittedDir)) {
    if (!entry.endsWith('.json')) continue;
    const relativePath = `tasks/submitted/${entry}`;
    const submitted = validateJsonFile(relativePath, [
      'schema_version',
      'task_id',
      'employee_id',
      'employee_alias',
      'employee_path',
      'submitted_at',
      'task_source',
      'employee_task_path',
      'wake_command',
      'task_snapshot'
    ]);
    if (submitted?.schema_version !== 'pm-submission.v1') fail(`${relativePath} schema_version must be pm-submission.v1`);
  }
}

if (pathExists(path.join(root, 'state/employees.json'))) {
  const index = validateJsonFile('state/employees.json', ['schema_version', 'updated_at', 'employees']);
  if (index?.schema_version !== 'pm-employees-index.v1') fail('state/employees.json schema_version must be pm-employees-index.v1');
}

if (pathExists(path.join(root, 'state/collections.json'))) {
  const collections = validateJsonFile('state/collections.json', ['schema_version', 'updated_at', 'items']);
  if (collections?.schema_version !== 'pm-collections.v1') fail('state/collections.json schema_version must be pm-collections.v1');
  if (!Array.isArray(collections?.items)) {
    fail('state/collections.json items must be an array');
  }
  for (const [index, item] of (collections?.items || []).entries()) {
    requireFields(item, [
      'key',
      'employee_id',
      'employee_alias',
      'task_id',
      'status',
      'source_json',
      'collected_json',
      'sha256',
      'first_collected_at',
      'last_collected_at'
    ], `state/collections.json items[${index}]`, errors);
  }
}

if (pathExists(path.join(root, 'state/task-ledger.json'))) {
  const ledger = validateJsonFile('state/task-ledger.json', ['schema_version', 'updated_at', 'tasks']);
  if (ledger?.schema_version !== LEDGER_SCHEMA) fail(`state/task-ledger.json schema_version must be ${LEDGER_SCHEMA}`);
  if (!Array.isArray(ledger?.tasks)) fail('state/task-ledger.json tasks must be an array');
  for (const [index, task] of (ledger?.tasks || []).entries()) {
    requireFields(task, [
      'schema_version',
      'key',
      'task_id',
      'title',
      'employee_id',
      'employee_alias',
      'task_type',
      'priority',
      'lifecycle',
      'result_status',
      'pm_status',
      'next_action',
      'updated_at'
    ], `state/task-ledger.json tasks[${index}]`, errors);
    if (task.schema_version !== 'pm-ledger-task.v1') fail(`state/task-ledger.json tasks[${index}] schema_version must be pm-ledger-task.v1`);
  }
}

if (pathExists(path.join(root, 'state/runs.json'))) {
  const runIndex = validateJsonFile('state/runs.json', ['schema_version', 'updated_at', 'runs']);
  if (runIndex?.schema_version !== RUN_INDEX_SCHEMA) fail(`state/runs.json schema_version must be ${RUN_INDEX_SCHEMA}`);
  if (!Array.isArray(runIndex?.runs)) fail('state/runs.json runs must be an array');
}

const runsDir = path.join(root, 'state/runs');
if (pathExists(runsDir)) {
  for (const entry of fs.readdirSync(runsDir)) {
    if (!entry.endsWith('.json')) continue;
    const relativePath = `state/runs/${entry}`;
    const run = validateJsonFile(relativePath, [
      'schema_version',
      'run_id',
      'task_id',
      'employee_id',
      'employee_alias',
      'status',
      'pid',
      'started_at',
      'ended_at',
      'exit_code',
      'timeout_minutes',
      'log_path',
      'submitted_path',
      'result_path'
    ]);
    if (run?.schema_version !== RUN_SCHEMA) fail(`${relativePath} schema_version must be ${RUN_SCHEMA}`);
    if (run?.status && !RUN_STATUSES.includes(run.status)) fail(`${relativePath} has invalid status`);
    if (run?.log_path && (!isSafeRelativePath(run.log_path) || !run.log_path.startsWith('logs/runs/'))) {
      fail(`${relativePath} log_path must be under logs/runs/`);
    }
    if (run?.submitted_path && (!isSafeRelativePath(run.submitted_path) || !run.submitted_path.startsWith('tasks/submitted/'))) {
      fail(`${relativePath} submitted_path must be under tasks/submitted/`);
    }
    if (run?.result_path && (!isSafeRelativePath(run.result_path) || !run.result_path.startsWith('results/collected/'))) {
      fail(`${relativePath} result_path must be under results/collected/`);
    }
  }
}

if (pathExists(path.join(root, 'logs/pm-events.jsonl'))) {
  const lines = readText(path.join(root, 'logs/pm-events.jsonl')).split(/\r?\n/).filter(Boolean);
  for (const [index, line] of lines.entries()) {
    try {
      const event = JSON.parse(line);
      requireFields(event, ['schema_version', 'event_id', 'ts', 'type', 'task_id', 'employee_id', 'decision', 'message', 'data'], `logs/pm-events.jsonl line ${index + 1}`, errors);
      if (event.schema_version !== PM_EVENT_SCHEMA) fail(`logs/pm-events.jsonl line ${index + 1} schema_version must be ${PM_EVENT_SCHEMA}`);
      if (event.decision && !VALID_PM_DECISIONS.includes(event.decision)) fail(`logs/pm-events.jsonl line ${index + 1} has invalid decision`);
      if (typeof event.data !== 'object' || event.data === null || Array.isArray(event.data)) fail(`logs/pm-events.jsonl line ${index + 1} data must be an object`);
    } catch (error) {
      fail(`logs/pm-events.jsonl line ${index + 1} is not valid JSON: ${error.message}`);
    }
  }
}

const collectedRoot = path.join(root, 'results/collected');
if (pathExists(collectedRoot)) {
  for (const employeeDir of fs.readdirSync(collectedRoot, { withFileTypes: true })) {
    if (!employeeDir.isDirectory()) continue;
    const fullDir = path.join(collectedRoot, employeeDir.name);
    for (const entry of fs.readdirSync(fullDir)) {
      if (!entry.endsWith('.json')) continue;
      const relativePath = `results/collected/${employeeDir.name}/${entry}`;
      const result = validateJsonFile(relativePath, []);
      if (result) validateResultPackage(result, relativePath, errors);
      const markdownPath = path.join(root, relativePath.replace(/\.json$/, '.md'));
      if (!pathExists(markdownPath)) fail(`${relativePath} is missing companion Markdown report`);
    }
  }
}

try {
  discoverEmployees(root, { writeIndex: false });
} catch (error) {
  fail(`employee discovery validation failed: ${error.message}`);
}

const git = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
if (git.status === 0) {
  const tracked = git.stdout.split(/\r?\n/).filter(Boolean);
  for (const trackedPath of tracked) {
    if (trackedPath === '.env') fail('.env must not be tracked by git');
    if (/^employees\/.+/.test(trackedPath) && trackedPath !== 'employees/.gitkeep') fail(`${trackedPath} must not be tracked by git`);
    if (/^state\/.+/.test(trackedPath) && trackedPath !== 'state/.gitkeep') fail(`${trackedPath} must not be tracked by git`);
    if (/^logs\/.+/.test(trackedPath) && trackedPath !== 'logs/.gitkeep') fail(`${trackedPath} must not be tracked by git`);
    if (/^results\/collected\/.+/.test(trackedPath) && trackedPath !== 'results/collected/.gitkeep') fail(`${trackedPath} must not be tracked by git`);
    if (/^tasks\/submitted\/.+/.test(trackedPath) && trackedPath !== 'tasks/submitted/.gitkeep') fail(`${trackedPath} must not be tracked by git`);
    if (/^tasks\/drafts\/.+\.json$/.test(trackedPath) && !trackedPath.endsWith('.example.json')) fail(`${trackedPath} must not be tracked by git`);
  }
}

if (errors.length > 0) {
  console.error(`validate failed with ${errors.length} error(s)`);
  process.exit(1);
}

console.log('validate passed');
