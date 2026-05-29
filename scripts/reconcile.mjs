#!/usr/bin/env node
import { appendPmEvent, reconcileLedger, writeLedger } from './lib/ledger.mjs';

const root = process.cwd();
const ledger = reconcileLedger(root);
writeLedger(root, ledger);
appendPmEvent(root, {
  type: 'reconciled',
  task_id: '',
  employee_id: '',
  decision: '',
  message: `reconciled ${ledger.tasks.length} task(s)`,
  data: {
    task_count: ledger.tasks.length
  }
});

console.log(`reconciled ${ledger.tasks.length} task(s) into state/task-ledger.json`);
