#!/usr/bin/env node
import {
  appendPmEvent,
  reconcileLedger,
  writeLedger,
  writeReworkDrafts
} from './lib/ledger.mjs';

const root = process.cwd();
let ledger = reconcileLedger(root);
writeLedger(root, ledger);
const reworkDrafts = writeReworkDrafts(root, ledger);
if (reworkDrafts.created.length > 0) {
  ledger = reconcileLedger(root);
  writeLedger(root, ledger);
}
appendPmEvent(root, {
  type: 'reconciled',
  task_id: '',
  employee_id: '',
  decision: '',
  message: `reconciled ${ledger.tasks.length} task(s)`,
  data: {
    task_count: ledger.tasks.length,
    rework_drafts_created: reworkDrafts.created.length,
    rework_drafts_skipped: reworkDrafts.skipped.length
  }
});

console.log(`reconciled ${ledger.tasks.length} task(s) into state/task-ledger.json`);
if (reworkDrafts.created.length > 0) {
  console.log(`created rework draft(s): ${reworkDrafts.created.join(', ')}`);
}
