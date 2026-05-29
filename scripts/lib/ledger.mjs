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
  safeFileName,
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

function failedVerificationItems(result) {
  if (!Array.isArray(result?.verification)) return [];
  return result.verification
    .filter((item) => item && item.passed === false)
    .map((item) => ({
      criterion: String(item.criterion || item.name || item.description || '未命名验收项'),
      note: String(item.note || item.detail || item.message || '')
    }));
}

function readResultForRow(root, collection, outboxResultPath) {
  if (collection?.collected_json) {
    const collectedPath = path.join(root, collection.collected_json);
    if (pathExists(collectedPath)) return readJson(collectedPath);
  }
  if (outboxResultPath && pathExists(outboxResultPath)) return readJson(outboxResultPath);
  return null;
}

function failedVerificationSummary(failedAcceptance) {
  return failedAcceptance
    .map((item) => item.note ? `${item.criterion} (${item.note})` : item.criterion)
    .join('; ');
}

function defaultPmStatusFor(row, previous) {
  if (['accepted', 'blocked', 'canceled'].includes(previous?.pm_status)) return previous.pm_status;
  if (previous?.pm_status === 'needs-rework' && previous.decision_updated_at) return previous.pm_status;
  if (row.verification_failed) return 'needs-rework';
  if (row.lifecycle === 'draft') return DRAFT_STATUS;
  if (row.lifecycle === 'submitted' || row.lifecycle === 'missing-inbox' || row.lifecycle === 'result-uncollected') return SUBMITTED_STATUS;
  if (row.lifecycle === 'completed' || row.lifecycle === 'failed' || row.lifecycle === 'collected') return REVIEW_PENDING;
  return previous?.pm_status || REVIEW_PENDING;
}

function defaultNextActionFor(pmStatus, lifecycle) {
  if (pmStatus === 'accepted') return 'done';
  if (pmStatus === 'needs-rework') return 'review generated rework draft';
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
    const result = readResultForRow(root, collection, outboxResultPath);
    const failedAcceptance = failedVerificationItems(result);
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
      verification_failed: failedAcceptance.length > 0,
      failed_acceptance: failedAcceptance,
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
      verification_failed: false,
      failed_acceptance: [],
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
    const pmStatus = defaultPmStatusFor(row, previous);
    const nextAction = previous?.next_action && previous.pm_status === pmStatus
      ? previous.next_action
      : defaultNextActionFor(pmStatus, row.lifecycle);
    const autoReviewNote = row.verification_failed
      ? `自动复核：以下验收未通过：${failedVerificationSummary(row.failed_acceptance)}`
      : '';
    const decisionUpdatedAt = previous?.decision_updated_at && previous.pm_status === pmStatus
      ? previous.decision_updated_at
      : (pmStatus === 'needs-rework' && row.verification_failed ? nowIso() : '');
    return {
      schema_version: 'pm-ledger-task.v1',
      ...row,
      pm_status: pmStatus,
      pm_decision_note: previous?.pm_decision_note && previous.pm_status === pmStatus
        ? previous.pm_decision_note
        : autoReviewNote,
      next_action: nextAction,
      decision_updated_at: decisionUpdatedAt,
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

function submittedRecordPath(root, task) {
  return path.join(
    root,
    'tasks/submitted',
    `${safeFileName(task.employee_id)}__${safeFileName(task.task_id)}.json`
  );
}

function findExistingReworkDraft(root, sourceKey) {
  for (const filePath of listJsonFiles(path.join(root, 'tasks/drafts'), { skipExamples: true })) {
    const task = readJson(filePath);
    if (task?.pm_context?.kind === 'rework' && task.pm_context.source_task_key === sourceKey) {
      return relativeFrom(root, filePath);
    }
  }
  return '';
}

function nextReworkTaskId(root, sourceTaskId) {
  for (let index = 1; index <= 99; index += 1) {
    const candidate = `${sourceTaskId}-rework-${index}`;
    const draftPath = path.join(root, 'tasks/drafts', `${safeFileName(candidate)}.json`);
    if (!pathExists(draftPath)) return candidate;
  }
  throw new Error(`cannot allocate rework task id for ${sourceTaskId}`);
}

function buildReworkTask(root, ledgerTask, originalTask, reworkTaskId) {
  const failedAcceptance = ledgerTask.failed_acceptance || [];
  const failedLines = failedAcceptance.map((item, index) => {
    const note = item.note ? `：${item.note}` : '';
    return `${index + 1}. ${item.criterion}${note}`;
  });
  const attachments = Array.isArray(originalTask.input?.attachments)
    ? [...originalTask.input.attachments]
    : [];
  if (ledgerTask.result_path) {
    attachments.push({
      type: 'pm_result_json',
      path: ledgerTask.result_path,
      description: 'PM collected result that failed verification'
    });
  }
  if (ledgerTask.markdown_path) {
    attachments.push({
      type: 'pm_result_markdown',
      path: ledgerTask.markdown_path,
      description: 'Human-readable report for the failed result'
    });
  }

  return {
    schema_version: 'employee-task.v1',
    task_id: reworkTaskId,
    created_at: nowIso(),
    priority: originalTask.priority || ledgerTask.priority || 'normal',
    task_type: originalTask.task_type || ledgerTask.task_type,
    assignee_level: originalTask.assignee_level || '',
    model_hint: originalTask.model_hint || '',
    input: {
      title: `返工：${originalTask.input?.title || ledgerTask.title}`,
      body_md: [
        `原任务 ${ledgerTask.task_id} 的 PM 自动复核发现验收未通过。`,
        '',
        '## 原任务正文',
        originalTask.input?.body_md || '',
        '',
        '## 未通过验收',
        failedLines.join('\n') || '- 未记录具体失败项',
        '',
        '## 原结果',
        ledgerTask.result_path ? `- JSON: ${ledgerTask.result_path}` : '- JSON: 未归档',
        ledgerTask.markdown_path ? `- Markdown: ${ledgerTask.markdown_path}` : '- Markdown: 未归档',
        '',
        '请只针对未通过验收补充执行，并按标准协议写出新的 result JSON 和 Markdown 报告。'
      ].join('\n'),
      attachments
    },
    acceptance: failedAcceptance.length > 0
      ? failedAcceptance.map((item) => item.criterion)
      : originalTask.acceptance || [],
    constraints: originalTask.constraints || {
      allowed_paths: ['workspace/**', 'outbox/**', 'state/status.json', 'logs/events.jsonl'],
      deadline_at: null
    },
    pm_context: {
      kind: 'rework',
      source_task_key: ledgerTask.key,
      source_task_id: ledgerTask.task_id,
      source_employee_id: ledgerTask.employee_id,
      result_path: ledgerTask.result_path,
      markdown_path: ledgerTask.markdown_path,
      failed_acceptance: failedAcceptance
    }
  };
}

export function writeReworkDrafts(root, ledger) {
  const created = [];
  const skipped = [];
  for (const task of ledger.tasks || []) {
    if (task.pm_status !== 'needs-rework') continue;
    if (!task.verification_failed || !Array.isArray(task.failed_acceptance) || task.failed_acceptance.length === 0) continue;

    const existingDraft = findExistingReworkDraft(root, task.key);
    if (existingDraft) {
      skipped.push(existingDraft);
      continue;
    }

    const submittedPath = submittedRecordPath(root, task);
    if (!pathExists(submittedPath)) continue;
    const submitted = readJson(submittedPath);
    const originalTask = submitted.task_snapshot;
    if (!originalTask) continue;

    const reworkTaskId = nextReworkTaskId(root, task.task_id);
    const draftPath = path.join(root, 'tasks/drafts', `${safeFileName(reworkTaskId)}.json`);
    const reworkTask = buildReworkTask(root, task, originalTask, reworkTaskId);
    writeJson(draftPath, reworkTask);
    const relativeDraftPath = relativeFrom(root, draftPath);
    created.push(relativeDraftPath);
    appendPmEvent(root, {
      type: 'rework_draft_created',
      task_id: task.task_id,
      employee_id: task.employee_id,
      decision: 'needs-rework',
      message: `created rework draft ${reworkTaskId}`,
      data: {
        source_task_key: task.key,
        rework_task_id: reworkTaskId,
        draft_path: relativeDraftPath
      }
    });
  }
  return { created, skipped };
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
