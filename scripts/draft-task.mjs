#!/usr/bin/env node
import path from 'node:path';
import {
  ensureDir,
  nowIso,
  parseArgs,
  pathExists,
  safeFileName,
  writeJson
} from './lib/project.mjs';
import {
  validateTaskPackage
} from './lib/protocol.mjs';

const root = process.cwd();
const args = parseArgs();

function usage() {
  console.error('usage: npm run draft -- --task-id task-0010 --title "任务标题" --body "任务正文" --type documentation --level junior [--priority normal] [--model junior-deepseek] [--acceptance "验收标准"] [--allowed-path "workspace/**"] [--deadline-at 2026-06-01T00:00:00.000Z] [--force]');
  process.exit(1);
}

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

function collect(value) {
  if (value === undefined || value === null || value === true) return [];
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap((item) => String(item).split(/\r?\n|\s*\|\|\s*/))
    .map((item) => item.trim())
    .filter(Boolean);
}

function required(name) {
  const value = first(args[name]);
  if (!value || value === true) usage();
  return String(value).trim();
}

function defaultModelForLevel(level) {
  if (level === 'senior') return 'senior-deepseek';
  if (level === 'junior') return 'junior-deepseek';
  return `${level}-default`;
}

const taskId = required('task-id');
if (safeFileName(taskId) !== taskId) {
  throw new Error('--task-id may only contain letters, numbers, dot, underscore, and dash');
}

const title = required('title');
const body = required('body');
const taskType = required('type');
const level = required('level');
const priority = first(args.priority) && first(args.priority) !== true ? String(first(args.priority)).trim() : 'normal';
const modelHint = first(args.model) && first(args.model) !== true ? String(first(args.model)).trim() : defaultModelForLevel(level);
const deadlineArg = first(args['deadline-at']);
const deadlineAt = deadlineArg && deadlineArg !== true && String(deadlineArg).trim() !== 'null'
  ? String(deadlineArg).trim()
  : null;

if (deadlineAt && Number.isNaN(Date.parse(deadlineAt))) {
  throw new Error('--deadline-at must be an ISO-compatible date string or null');
}

const acceptance = collect(args.acceptance);
const allowedPaths = collect(args['allowed-path']);

const task = {
  schema_version: 'employee-task.v1',
  task_id: taskId,
  created_at: nowIso(),
  priority,
  task_type: taskType,
  assignee_level: level,
  model_hint: modelHint,
  input: {
    title,
    body_md: body,
    attachments: []
  },
  acceptance: acceptance.length > 0 ? acceptance : [
    '员工必须写出标准 result JSON，并在 verification 中说明本任务的验收情况。',
    '员工必须写出 Markdown companion 报告，包含 Result、Verification、Notes。'
  ],
  constraints: {
    allowed_paths: allowedPaths.length > 0 ? allowedPaths : [
      `inbox/tasks/${taskId}.json`,
      'workspace/**',
      'outbox/**',
      'state/status.json',
      'logs/events.jsonl'
    ],
    deadline_at: deadlineAt
  }
};

const errors = [];
validateTaskPackage(task, `tasks/drafts/${taskId}.json`, errors);
if (errors.length > 0) throw new Error(errors.join('\n'));

const draftPath = path.join(root, 'tasks/drafts', `${safeFileName(taskId)}.json`);
if (pathExists(draftPath) && !args.force) {
  throw new Error(`${path.relative(root, draftPath)} already exists; pass --force to overwrite`);
}

ensureDir(path.dirname(draftPath));
writeJson(draftPath, task);
console.log(`draft created: ${path.relative(root, draftPath).replaceAll(path.sep, '/')}`);
console.log(`next: npm run intake -- --file tasks/drafts/${safeFileName(taskId)}.json --dry-run`);
