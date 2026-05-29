#!/usr/bin/env node
import { applyDecision } from './lib/ledger.mjs';

const root = process.cwd();

try {
  const task = applyDecision(root);
  console.log(`resolved ${task.task_id} for ${task.employee_alias || task.employee_id || 'unassigned'}`);
  console.log(`pm_status: ${task.pm_status}`);
  console.log(`next_action: ${task.next_action}`);
} catch (error) {
  console.error(`error - ${error.message}`);
  process.exit(1);
}
