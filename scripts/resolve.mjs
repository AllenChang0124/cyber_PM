#!/usr/bin/env node
import { applyDecision } from './lib/ledger.mjs';
import { parseArgs } from './lib/project.mjs';
import { withLock } from './lib/lock.mjs';

const root = process.cwd();
const args = parseArgs();

try {
  const task = withLock(root, 'resolve', {
    task_id: args.task || '',
    employee: args.employee || '',
    decision: args.decision || ''
  }, () => applyDecision(root));
  console.log(`resolved ${task.task_id} for ${task.employee_alias || task.employee_id || 'unassigned'}`);
  console.log(`pm_status: ${task.pm_status}`);
  console.log(`next_action: ${task.next_action}`);
} catch (error) {
  console.error(`error - ${error.message}`);
  process.exit(1);
}
