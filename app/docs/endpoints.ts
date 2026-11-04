import reference from '@/lib/generated/api-reference.json';
import anchors from './anchors.json';

export interface Schema {
  type?: string | string[];
  anyOf?: Schema[];
  description?: string;
  format?: string;
  minimum?: number;
  exclusiveMinimum?: number;
  maximum?: number;
  default?: unknown;
  enum?: string[];
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}
export interface Parameter {
  name: string;
  in: string;
  required: boolean;
  description?: string;
  schema: Schema;
}
export interface ApiEndpoint {
  id: string;
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  category: string;
  description: string;
  parameters: Parameter[];
  requestBody: Schema | null;
  pagination: string | null;
  zatoshiFields: string[];
  ownershipToken: boolean;
  example: string;
  bodyExample: string | null;
}
export const categoryNames: Record<string, string> = {
  ask: 'Zift (Ask API)',
  blocks: 'Blocks', transactions: 'Transactions', address: 'Addresses', mempool: 'Mempool',
  network: 'Network', 'shielded-pools': 'Shielded pools', privacy: 'Privacy', mining: 'Mining',
  crosschain: 'Cross-chain', valuation: 'Valuation', analytics: 'Analytics', stats: 'Statistics',
  migration: 'Pool migration', transparent: 'Transparent exposure', pulse: 'Network pulse',
  names: 'Names', search: 'Search', scan: 'Wallet scanning', reorgs: 'Forks & reorgs', crosslink: 'Crosslink',
};
export const categoryId = (category: string) => `category-${category}`;
// Values illustrate request syntax; identifiers and credentials stay explicit placeholders.
export function parameterValue(param: Parameter): string {
  if (param.name === 'cursor') return '<cursor-from-meta.page>';
  if (param.in === 'header') return '<ownership-token>';
  if (param.in === 'path') return ['height', 'heightOrHash', 'hashOrHeight'].includes(param.name) ? '3000000' : `<${param.name}>`;
  if (param.schema.default !== undefined) return String(param.schema.default);
  if (param.schema.enum?.length) return String(param.schema.enum[0]);
  if (param.schema.format === 'date') return '2026-09-01';
  if (param.name === 'amount' && param.schema.type === 'number') return '1';
  return `<${param.name}>`;
}
export function parameterUsage(param: Parameter, path: string): string {
  const value = parameterValue(param);
  if (param.in === 'path') return path.replace(`:${param.name}`, value);
  if (param.in === 'header') return `-H '${param.name}: ${value}'`;
  return `${param.name}=${value}`;
}
function bodyValue(schema: Schema, name: string): unknown {
  if (schema.type === 'null' || schema.anyOf?.some(choice => choice.type === 'null')) return null;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum?.length) return schema.enum[0];
  if (schema.type === 'object') return Object.fromEntries((schema.required || []).map(key => [key, bodyValue(schema.properties?.[key] || {}, key)]));
  if (schema.type === 'array') return [bodyValue(schema.items || {}, name === 'heights' ? 'height' : name === 'txids' ? 'txid' : name)];
  if (schema.type === 'boolean') return false;
  if (schema.type === 'integer' || schema.type === 'number') return name === 'startHeight' ? 3000000 : name === 'endHeight' ? 3000009 : name === 'height' || name === 'tip' ? 100 : Math.max(schema.minimum ?? 1, 1);
  return name === 'rawTx' ? '<signed-transaction-hex>' : `<${name}>`;
}
// Discovery order: collection, resource detail, other reads, then mutations.
export function compareEndpoints(a: ApiEndpoint, b: ApiEndpoint): number {
  const rank = (e: ApiEndpoint) => e.method !== 'GET' ? (e.method === 'POST' ? 3 : 4) : e.path.split('/').length === 3 ? 0 : /^\/v1\/[^/]+\/:[^/]+$/.test(e.path) ? 1 : 2;
  return rank(a) - rank(b) || a.path.localeCompare(b.path, 'en') || a.method.localeCompare(b.method, 'en');
}
export function getEndpoints(baseUrl: string): ApiEndpoint[] {
  return reference.map(route => {
    const parameters = route.parameters as Parameter[];
    const requestBody = route.requestBody as Schema | null;
    const query = parameters.filter(p => p.in === 'query' && p.required).map(p => `${p.name}=${parameterValue(p)}`);
    if (route.pagination === 'cursor') query.push('limit=25');
    const url = baseUrl.replace(/\/$/, '') + route.path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '<$1>') + (query.length ? `?${query.join('&')}` : '');
    const headers = route.ownershipToken && route.method === 'DELETE' ? " \\\n  -H 'X-Node-Token: <ownership-token>'" : '';
    return {
      id: (anchors as Record<string, string>)[`${route.method} ${route.path}`] || `${route.method.toLowerCase()}-${route.path.slice(4).replace(/[^a-zA-Z0-9]+/g, '-')}`,
      method: route.method as ApiEndpoint['method'], path: route.path, category: route.category,
      description: route.description, parameters, requestBody,
      bodyExample: requestBody ? JSON.stringify(bodyValue(requestBody, 'body'), null, 2) : null,
      pagination: route.pagination, zatoshiFields: route.zatoshiFields, ownershipToken: route.ownershipToken,
      example: `curl${route.method === 'GET' ? '' : ` -X ${route.method}`} '${url}'${headers}${route.method === 'POST' ? " \\\n  -H 'Content-Type: application/json' \\\n  --data @request.json" : ''}`,
    };
  });
}
export function getEndpointsByCategory(baseUrl: string) {
  const endpoints = getEndpoints(baseUrl);
  return Object.entries(categoryNames).map(([key, name]) => ({ key, name, endpoints: endpoints.filter(e => e.category === key).sort(compareEndpoints) })).filter(c => c.endpoints.length);
}
export function describeSchema(schema: Schema): string {
  const parts: string[] = [];
  if (schema.description) parts.push(schema.description);
  if (schema.format) parts.push(`Format: ${schema.format}.`);
  if (schema.default !== undefined) parts.push(`Default: ${schema.default}.`);
  if (schema.minimum !== undefined) parts.push(`Minimum: ${schema.minimum}.`);
  if (schema.exclusiveMinimum !== undefined) parts.push(`Greater than ${schema.exclusiveMinimum}.`);
  if (schema.maximum !== undefined) parts.push(`Maximum: ${schema.maximum}.`);
  if (schema.enum) parts.push(`Values: ${schema.enum.join(', ')}.`);
  if (schema.minItems !== undefined) parts.push(`At least ${schema.minItems} item(s).`);
  if (schema.maxItems !== undefined) parts.push(`At most ${schema.maxItems} items.`);
  if (schema.minLength !== undefined) parts.push(`Minimum length: ${schema.minLength}.`);
  if (schema.maxLength !== undefined) parts.push(`Maximum length: ${schema.maxLength}.`);
  if (schema.pattern) parts.push(`Pattern: ${schema.pattern}`);
  return parts.join(' ');
}
