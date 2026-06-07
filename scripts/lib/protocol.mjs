import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

function protocolIndexPath(protocolDir) {
  return path.join(protocolDir, 'index.mjs');
}

function protocolCandidates(startDir) {
  const candidates = [];
  let current = path.resolve(startDir);
  while (true) {
    candidates.push(path.join(current, 'cyber_protocol'));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return candidates;
}

function resolveProtocolDir() {
  if (process.env.CYBER_PROTOCOL_DIR) {
    const explicit = path.resolve(process.cwd(), process.env.CYBER_PROTOCOL_DIR);
    if (pathExists(protocolIndexPath(explicit))) return explicit;
    throw new Error(`CYBER_PROTOCOL_DIR does not contain index.mjs: ${explicit}`);
  }

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const starts = [process.cwd(), moduleDir];
  const seen = new Set();
  for (const start of starts) {
    for (const candidate of protocolCandidates(start)) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      if (pathExists(protocolIndexPath(candidate))) return candidate;
    }
  }

  throw new Error('cyber_protocol not found; set CYBER_PROTOCOL_DIR or place cyber_protocol as a sibling/ancestor repo');
}

const sharedProtocol = await import(pathToFileURL(protocolIndexPath(resolveProtocolDir())).href);

export const TASK_FIELDS = sharedProtocol.TASK_FIELDS;
export const RESULT_FIELDS = sharedProtocol.RESULT_FIELDS;
export const AGENT_FIELDS = sharedProtocol.AGENT_FIELDS;
export const STATUS_FIELDS = sharedProtocol.STATUS_FIELDS;

export const PRIORITIES = sharedProtocol.PRIORITIES;
export const TASK_TYPES = sharedProtocol.TASK_TYPES;
export const ASSIGNEE_LEVELS = sharedProtocol.ASSIGNEE_LEVELS;
export const RESULT_STATUSES = sharedProtocol.RESULT_STATUSES;
export const EMPLOYEE_STATES = sharedProtocol.EMPLOYEE_STATES;

export const PROTOCOL_VERSIONS = sharedProtocol.PROTOCOL_VERSIONS;

function validateEnum(value, allowed, label, errors) {
  if (!allowed.includes(value)) {
    errors.push(`${label} must be one of: ${allowed.map((item) => item || '(empty)').join(', ')}`);
  }
}

export function requireFields(object, fields, label, errors) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) {
    errors.push(`${label} must be an object`);
    return;
  }
  for (const field of fields) {
    if (!(field in object)) errors.push(`${label} missing required field: ${field}`);
  }
}

function appendSchemaIssues(result, errors) {
  for (const issue of result.issues || []) errors.push(issue.message || String(issue));
}

export function validateTaskPackage(task, label, errors) {
  appendSchemaIssues(sharedProtocol.validateTaskPackage(task, label), errors);
}

export function validateResultPackage(result, label, errors) {
  appendSchemaIssues(sharedProtocol.validateResultPackage(result, label), errors);
}

export function validateAgent(agent, label, errors) {
  appendSchemaIssues(sharedProtocol.validateAgentDocument(agent, label), errors);
  requireFields(agent?.paths, ['inbox', 'outbox', 'status', 'events'], `${label} paths`, errors);
  if (agent?.paths) {
    for (const [key, value] of Object.entries(agent.paths)) {
      if (!isSafeRelativePath(value)) errors.push(`${label} paths.${key} must be project-relative`);
    }
  }
}

export function validateStatus(status, label, errors) {
  appendSchemaIssues(sharedProtocol.validateStatusDocument(status, label), errors);
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
