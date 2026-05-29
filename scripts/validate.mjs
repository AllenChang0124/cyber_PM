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
for (const scriptName of ['doctor', 'validate', 'setup:demo', 'discover', 'submit', 'status', 'collect']) {
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
