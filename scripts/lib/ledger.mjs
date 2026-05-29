import fs from 'node:fs';
import path from 'node:path';
import {
  ensureDir,
  nowIso,
  parseArgs,
  pathExists,
  readJson,
  readText,
  relativeFrom,
  writeJson,
  writeText
} from './project.mjs';
import {
  discoverEmployees,
  employeeProtocolPath,
  validateTaskPackage
} from './protocol.mjs';

export const LEDGER_SCHEMA = 'pm-task-ledger.v1';
export const PM_EVENT_SCHEMA = 'pm-event.v1';
export const REVIEW_PENDING = 'review-pending';
export const DRAFT_STATUS = 'draft';
export const SUBMITTED_STATUS = 'submitted';
export const VALID_PM_DECISIONS = ['accepted', 'needs-rework', 'blocked', 'canceled'];

export function listJsonFiles(dirPath, options = {}) {
  if (!pathExists(dirPath)) return [];
  return fs.readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .filter((entry) => !(options.skipExamples && entry.name.endsWith('.example.json')))
    .map((entry) => path.join(dirPath, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

export function readCollections(root) {
  const collectionsPath = path.join(root, 'state/collections.json');
  if (!pathExists(collectionsPath)) return [];
  const collections = readJson(collectionsPath);
  return Array.isArray(collections.items) ? collections.items : [];
}

export function readLedger(root) {
  const ledgerPath = path.join(root, 'state/task-ledger.json');
  if (!pathExists(ledgerPath)) {
    return { schema_version: LEDGER_SCHEMA, updated_at: '', tasks: [] };
  }
  return readJson(ledgerPath);
}

export function writeLedger(root, ledger) {
  writeJson(path.join(root, 'state/task-ledger.json'), ledger);
}

export function appendPmEvent(root, event) {
  const eventsPath = path.join(root, 'logs/pm-events.jsonl');
  ensureDir(path.dirname(eventsPath));
  const line = JSON.stringify({
    schema_version: PM_EVENT_SCHEMA,
    event_id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    ts: nowIso(),
    ...event
  });
  const existing = pathExists(eventsPath) ? readText(eventsPath) : '';
  writeText(eventsPath, `${existing}${line}\n`);
}

function ledgerKey(employeeId, taskId) {
  return `${employeeId || 'unassigned'}__${taskId}`;
}

function defaultPmStatusFor(lifecycle, previous) {
  if (previous?.pm_status && previous.pm_status !== REVIEW_PENDING) return previous.pm_status;
  if (lifecycle === 'draft') return DRAFT_STATUS;
  if (lifecycle === 'submitted' || lifecycle === 'missing-inbox' || lifecycle === 'result-uncollected') return SUBMITTED_STATUS;
  if (lifecycle === 'completed' || lifecycle === 'failed' || lifecycle === 'collected') return REVIEW_PENDING;
  return previous?.pm_status || REVIEW_PENDING;
}

function defaultNextActionFor(pmStatus, lifecycle) {
  if (pmStatus === 'accepted') return 'done';
  if (pmStatus === 'needs-rework') return 'create follow-up task manually';
  if (pmStatus === 'blocked') return 'resolve blocker manually';
  if (pmStatus === 'canceled') return 'none';
  if (pmStatus === DRAFT_STATUS) return 'submit task when ready';
  if (lifecycle === 'result-uncollected') return 'run npm run collect';
  if (pmStatus === SUBMITTED_STATUS) return 'wake employee manually';
  if (pmStatus === REVIEW_PENDING) return 'review result and run npm run resolve';
  return '';
}

function lifecycleFor({ root, collection, submitted, outboxResultPath }) {
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

export function buildLiveTaskRows(root) {
  const errors = [];
  const index = discoverEmployees(root, { writeIndex: false });
  const collections = readCollections(root);
  const collectionsByKey = new Map(collections.map((item) => [item.key, item]));
  const employeeById = new Map(index.employees.map((employee) => [employee.employee_id, employee]));

  const submissions = [];
  for (const filePath of listJsonFiles(path.join(root, 'tasks/submitted'))) {
    const submitted = readJson(filePath);
    const key = ledgerKey(submitted.employee_id, submitted.task_id);
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
    const outboxResult = outboxResultPath && pathExists(outboxResultPath) ? readJson(outboxResultPath) : null;
    const lifecycle = lifecycleFor({ root, collection, submitted, outboxResultPath });

    rows.push({
      key: submitted.key,
      task_id: submitted.task_id,
      title: task.input?.title || '',
      employee_id: submitted.employee_id,
      employee_alias: submitted.employee_alias || submitted.employee_id,
      task_type: task.task_type || '',
      priority: task.priority || '',
      lifecycle,
      result_status: collection?.status || outboxResult?.status || '',
      submitted_at: submitted.submitted_at || '',
      collected_at: collection?.last_collected_at || '',
      updated_at: collection?.last_collected_at || submitted.submitted_at || task.created_at || '',
      task_source: submitted.task_source || '',
      employee_task_path: submitted.employee_task_path || '',
      result_path: collection?.collected_json || '',
      markdown_path: collection?.collected_md || '',
      wake_command: submitted.wake_command || '',
      source: 'submitted'
    });
  }

  for (const filePath of listJsonFiles(path.join(root, 'tasks/drafts'), { skipExamples: true })) {
    const task = readJson(filePath);
    validateTaskPackage(task, relativeFrom(root, filePath), errors);
    if (submittedTaskIds.has(task.task_id)) continue;
    rows.push({
      key: ledgerKey('', task.task_id),
      task_id: task.task_id,
      title: task.input?.title || '',
      employee_id: '',
      employee_alias: '',
      task_type: task.task_type || '',
      priority: task.priority || '',
      lifecycle: 'draft',
      result_status: '',
      submitted_at: '',
      collected_at: '',
      updated_at: task.created_at || '',
      task_source: relativeFrom(root, filePath),
      employee_task_path: '',
      result_path: '',
      markdown_path: '',
      wake_command: '',
      source: 'draft'
    });
  }

  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }

  rows.sort((a, b) => `${a.task_id}:${a.employee_alias}`.localeCompare(`${b.task_id}:${b.employee_alias}`));
  return rows;
}

export function reconcileLedger(root) {
  const previousLedger = readLedger(root);
  const previousByKey = new Map((previousLedger.tasks || []).map((task) => [task.key, task]));
  const liveRows = buildLiveTaskRows(root);
  const tasks = liveRows.map((row) => {
    const previous = previousByKey.get(row.key);
    const pmStatus = defaultPmStatusFor(row.lifecycle, previous);
    const nextAction = previous?.next_action && previous.pm_status === pmStatus
      ? previous.next_action
      : defaultNextActionFor(pmStatus, row.lifecycle);
    return {
      schema_version: 'pm-ledger-task.v1',
      ...row,
      pm_status: pmStatus,
      pm_decision_note: previous?.pm_decision_note || '',
      next_action: nextAction,
      decision_updated_at: previous?.decision_updated_at || '',
      first_seen_at: previous?.first_seen_at || nowIso(),
      updated_at: row.updated_at || nowIso()
    };
  });

  return {
    schema_version: LEDGER_SCHEMA,
    updated_at: nowIso(),
    tasks
  };
}

export function findLedgerTask(ledger, taskId, employeeSelector) {
  return (ledger.tasks || []).find((task) => (
    task.task_id === taskId
    && (!employeeSelector || task.employee_id === employeeSelector || task.employee_alias === employeeSelector)
  ));
}

export function applyDecision(root, args = parseArgs()) {
  if (!args.task || !args.decision) {
    throw new Error('usage: npm run resolve -- --task task-0001 --employee junior-demo --decision accepted --note "验收通过"');
  }
  if (!VALID_PM_DECISIONS.includes(args.decision)) {
    throw new Error(`decision must be one of: ${VALID_PM_DECISIONS.join(', ')}`);
  }

  const ledger = pathExists(path.join(root, 'state/task-ledger.json'))
    ? readLedger(root)
    : reconcileLedger(root);
  const task = findLedgerTask(ledger, args.task, args.employee);
  if (!task) {
    throw new Error(`task not found in ledger: ${args.task}`);
  }

  const now = nowIso();
  task.pm_status = args.decision;
  task.pm_decision_note = args.note || '';
  task.next_action = args.next_action || defaultNextActionFor(args.decision, task.lifecycle);
  task.decision_updated_at = now;
  task.updated_at = now;

  ledger.updated_at = now;
  writeLedger(root, ledger);
  appendPmEvent(root, {
    type: 'resolved',
    task_id: task.task_id,
    employee_id: task.employee_id,
    decision: args.decision,
    message: args.note || '',
    data: {
      key: task.key,
      pm_status: task.pm_status,
      next_action: task.next_action
    }
  });

  return task;
}
