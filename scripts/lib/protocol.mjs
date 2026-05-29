import fs from 'node:fs';
import path from 'node:path';
import {
  ensureDir,
  isSafeRelativePath,
  nowIso,
  pathExists,
  readJson,
  relativeFrom,
  toPosix,
  writeJson
} from './project.mjs';

export const TASK_FIELDS = [
  'schema_version',
  'task_id',
  'created_at',
  'priority',
  'task_type',
  'assignee_level',
  'model_hint',
  'input',
  'acceptance',
  'constraints'
];

export const RESULT_FIELDS = [
  'schema_version',
  'task_id',
  'status',
  'model_used',
  'started_at',
  'completed_at',
  'summary',
  'changes',
  'verification',
  'artifacts',
  'notes'
];

export const AGENT_FIELDS = [
  'schema_version',
  'employee_id',
  'name',
  'level',
  'role',
  'default_model_profile',
  'capabilities',
  'accepts_task_types',
  'paths'
];

export const STATUS_FIELDS = [
  'schema_version',
  'employee_id',
  'state',
  'active_task_id',
  'model_profile',
  'updated_at'
];

export function requireFields(object, fields, label, errors) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) {
    errors.push(`${label} must be an object`);
    return;
  }
  for (const field of fields) {
    if (!(field in object)) errors.push(`${label} missing required field: ${field}`);
  }
}

export function validateTaskPackage(task, label, errors) {
  requireFields(task, TASK_FIELDS, label, errors);
  if (task?.schema_version && task.schema_version !== 'employee-task.v1') {
    errors.push(`${label} schema_version must be employee-task.v1`);
  }
  requireFields(task?.input, ['title', 'body_md', 'attachments'], `${label} input`, errors);
  requireFields(task?.constraints, ['allowed_paths', 'deadline_at'], `${label} constraints`, errors);
  if (task?.input?.attachments && !Array.isArray(task.input.attachments)) {
    errors.push(`${label} input.attachments must be an array`);
  }
  if (task?.acceptance && !Array.isArray(task.acceptance)) {
    errors.push(`${label} acceptance must be an array`);
  }
  if (task?.constraints?.allowed_paths && !Array.isArray(task.constraints.allowed_paths)) {
    errors.push(`${label} constraints.allowed_paths must be an array`);
  }
}

export function validateResultPackage(result, label, errors) {
  requireFields(result, RESULT_FIELDS, label, errors);
  if (result?.schema_version && result.schema_version !== 'employee-result.v1') {
    errors.push(`${label} schema_version must be employee-result.v1`);
  }
  for (const field of ['changes', 'verification', 'artifacts', 'notes']) {
    if (result?.[field] && !Array.isArray(result[field])) {
      errors.push(`${label} ${field} must be an array`);
    }
  }
}

export function validateAgent(agent, label, errors) {
  requireFields(agent, AGENT_FIELDS, label, errors);
  if (agent?.schema_version && agent.schema_version !== 'employee-agent.v1') {
    errors.push(`${label} schema_version must be employee-agent.v1`);
  }
  requireFields(agent?.paths, ['inbox', 'outbox', 'status', 'events'], `${label} paths`, errors);
  if (agent?.paths) {
    for (const [key, value] of Object.entries(agent.paths)) {
      if (!isSafeRelativePath(value)) errors.push(`${label} paths.${key} must be project-relative`);
    }
  }
}

export function validateStatus(status, label, errors) {
  requireFields(status, STATUS_FIELDS, label, errors);
  if (status?.schema_version && status.schema_version !== 'employee-status.v1') {
    errors.push(`${label} schema_version must be employee-status.v1`);
  }
}

export function loadEmployeeConfig(root) {
  const configPath = path.join(root, 'config/employees.json');
  const config = readJson(configPath);
  const errors = [];
  requireFields(config, ['schema_version', 'employees'], 'config/employees.json', errors);
  if (config.schema_version !== 'pm-employees-config.v1') {
    errors.push('config/employees.json schema_version must be pm-employees-config.v1');
  }
  if (!Array.isArray(config.employees)) {
    errors.push('config/employees.json employees must be an array');
  }
  for (const [index, employee] of (config.employees || []).entries()) {
    requireFields(employee, ['alias', 'path', 'enabled', 'tags', 'notes'], `config employee ${index}`, errors);
    if (employee.path && !isSafeRelativePath(employee.path)) {
      errors.push(`config employee ${index} path must be project-relative`);
    }
    if (employee.path && !toPosix(employee.path).startsWith('employees/')) {
      errors.push(`config employee ${index} path must be under employees/`);
    }
    if (employee.tags && !Array.isArray(employee.tags)) {
      errors.push(`config employee ${index} tags must be an array`);
    }
  }
  if (errors.length > 0) throw new Error(errors.join('\n'));
  return config;
}

export function readStatusIfPresent(employeeRoot, agent) {
  const statusPath = path.join(employeeRoot, agent.paths.status);
  if (!pathExists(statusPath)) return null;
  return readJson(statusPath);
}

export function discoverEmployees(root, options = {}) {
  const config = loadEmployeeConfig(root);
  const employeesRoot = path.join(root, 'employees');
  ensureDir(employeesRoot);

  const configByPath = new Map();
  for (const entry of config.employees) configByPath.set(toPosix(entry.path), entry);

  const discoveredPaths = new Set();
  const records = [];
  const errors = [];

  for (const entry of fs.readdirSync(employeesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const employeePath = toPosix(path.join('employees', entry.name));
    const employeeRoot = path.join(root, employeePath);
    const agentPath = path.join(employeeRoot, 'agent.json');
    if (!pathExists(agentPath)) continue;

    discoveredPaths.add(employeePath);
    const registration = configByPath.get(employeePath) || {};
    const agent = readJson(agentPath);
    validateAgent(agent, `${employeePath}/agent.json`, errors);
    const status = readStatusIfPresent(employeeRoot, agent);
    if (status) validateStatus(status, `${employeePath}/${agent.paths.status}`, errors);

    records.push({
      alias: registration.alias || entry.name,
      employee_id: agent.employee_id,
      name: agent.name,
      level: agent.level,
      role: agent.role,
      enabled: registration.enabled ?? true,
      path: employeePath,
      tags: registration.tags || [],
      notes: registration.notes || '',
      default_model_profile: agent.default_model_profile,
      capabilities: agent.capabilities,
      accepts_task_types: agent.accepts_task_types,
      paths: agent.paths,
      status,
      discovered: true
    });
  }

  for (const registration of config.employees) {
    const employeePath = toPosix(registration.path);
    if (discoveredPaths.has(employeePath)) continue;
    records.push({
      alias: registration.alias,
      employee_id: '',
      name: '',
      level: '',
      role: '',
      enabled: registration.enabled,
      path: employeePath,
      tags: registration.tags,
      notes: registration.notes,
      default_model_profile: '',
      capabilities: [],
      accepts_task_types: [],
      paths: null,
      status: null,
      discovered: false
    });
  }

  records.sort((a, b) => a.alias.localeCompare(b.alias));

  if (errors.length > 0) throw new Error(errors.join('\n'));

  const index = {
    schema_version: 'pm-employees-index.v1',
    updated_at: nowIso(),
    employees: records
  };

  if (options.writeIndex) {
    writeJson(path.join(root, 'state/employees.json'), index);
  }

  return index;
}

export function findEmployee(index, selector) {
  return index.employees.find((employee) => (
    employee.enabled
    && employee.discovered
    && (employee.alias === selector || employee.employee_id === selector)
  ));
}

export function employeeRoot(root, employee) {
  return path.join(root, employee.path);
}

export function employeeProtocolPath(root, employee, protocolPath) {
  return path.join(employeeRoot(root, employee), protocolPath);
}

export function relativeProtocolPath(root, employee, protocolPath) {
  return relativeFrom(root, employeeProtocolPath(root, employee, protocolPath));
}
