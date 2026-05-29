#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  pathExists,
  printTable,
  readJson,
  relativeFrom
} from './lib/project.mjs';
import {
  discoverEmployees,
  employeeProtocolPath,
  validateTaskPackage
} from './lib/protocol.mjs';

const root = process.cwd();
const errors = [];

function listJsonFiles(dirPath, options = {}) {
  if (!pathExists(dirPath)) return [];
  return fs.readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .filter((entry) => !(options.skipExamples && entry.name.endsWith('.example.json')))
    .map((entry) => path.join(dirPath, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

function readCollections() {
  const collectionsPath = path.join(root, 'state/collections.json');
  if (!pathExists(collectionsPath)) return [];
  const collections = readJson(collectionsPath);
  return Array.isArray(collections.items) ? collections.items : [];
}

function lifecycleFor({ collection, submitted, outboxResultPath }) {
  if (collection) {
    if (collection.status === 'completed') return 'completed';
    if (['failed', 'blocked'].includes(collection.status)) return 'failed';
    return 'collected';
  }

  if (outboxResultPath && pathExists(outboxResultPath)) return 'result-uncollected';
  if (submitted && !pathExists(path.join(root, submitted.employee_task_path))) return 'missing-inbox';
  if (submitted) return 'submitted';
  return 'draft';
}

const index = discoverEmployees(root, { writeIndex: false });
const collections = readCollections();
const collectionsByKey = new Map(collections.map((item) => [item.key, item]));
const employeeById = new Map(index.employees.map((employee) => [employee.employee_id, employee]));

const submissions = [];
for (const filePath of listJsonFiles(path.join(root, 'tasks/submitted'))) {
  const submitted = readJson(filePath);
  const key = `${submitted.employee_id}__${submitted.task_id}`;
  submissions.push({ ...submitted, key, filePath });
}

const submittedTaskIds = new Set(submissions.map((item) => item.task_id));
const rows = [];

for (const submitted of submissions) {
  const task = submitted.task_snapshot || {};
  validateTaskPackage(task, relativeFrom(root, submitted.filePath), errors);
  const employee = employeeById.get(submitted.employee_id);
  const collection = collectionsByKey.get(submitted.key);
  const outboxResultPath = employee?.paths
    ? employeeProtocolPath(root, employee, path.join(employee.paths.outbox, `${submitted.task_id}.json`))
    : null;

  const lifecycle = lifecycleFor({ collection, submitted, outboxResultPath });
  const resultStatus = collection?.status || (
    outboxResultPath && pathExists(outboxResultPath) ? readJson(outboxResultPath).status : ''
  );

  rows.push({
    task_id: submitted.task_id,
    title: task.input?.title || '',
    employee: submitted.employee_alias || submitted.employee_id,
    task_type: task.task_type || '',
    priority: task.priority || '',
    lifecycle,
    result_status: resultStatus || '',
    updated_at: collection?.last_collected_at || submitted.submitted_at || task.created_at || ''
  });
}

for (const filePath of listJsonFiles(path.join(root, 'tasks/drafts'), { skipExamples: true })) {
  const task = readJson(filePath);
  validateTaskPackage(task, relativeFrom(root, filePath), errors);
  if (submittedTaskIds.has(task.task_id)) continue;
  rows.push({
    task_id: task.task_id,
    title: task.input?.title || '',
    employee: '',
    task_type: task.task_type || '',
    priority: task.priority || '',
    lifecycle: 'draft',
    result_status: '',
    updated_at: task.created_at || ''
  });
}

if (errors.length > 0) {
  for (const error of errors) console.error(`error - ${error}`);
  process.exit(1);
}

rows.sort((a, b) => `${a.task_id}:${a.employee}`.localeCompare(`${b.task_id}:${b.employee}`));

printTable(rows, [
  { key: 'task_id', header: 'task_id' },
  { key: 'title', header: 'title' },
  { key: 'employee', header: 'employee' },
  { key: 'task_type', header: 'task_type' },
  { key: 'priority', header: 'priority' },
  { key: 'lifecycle', header: 'lifecycle' },
  { key: 'result_status', header: 'result_status' },
  { key: 'updated_at', header: 'updated_at' }
]);
