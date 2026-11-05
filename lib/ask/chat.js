/* eslint-disable @typescript-eslint/no-require-imports */
const { z } = require('zod');
const { analysisSchema, metricIds } = require('./contract');
const { querySchema } = require('./query-contract');
const { sqlQuerySchema } = require('./research-contract');
const { pageIds } = require('./pages');
const { researchIds } = require('./research-catalogue');
const locales = ['en', 'fr', 'es', 'de', 'pt', 'ja', 'zh', 'ko', 'ar', 'ru'];
// What the previous answer actually ran, written by the server and sent back
// by the client on the next question. Untrusted on the way back: only short
// snake_case labels, enums and ISO dates, never questions, SQL or values.
const scopeLabel = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/);
const scopeDate = z.string().regex(/^20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/);
const scopePools = ['orchard', 'ironwood', 'sapling', 'sprout', 'transparent'];
const turnScopeSchema = z.object({
  version: z.literal(1),
  kind: z.enum(['sql', 'chart', 'block', 'transaction']),
  datasets: z.array(z.enum(researchIds)).max(6),
  measures: z.array(scopeLabel).max(6),
  pools: z.array(z.enum(scopePools)).max(5),
  window: z.object({ start: scopeDate, end: scopeDate }).strict().refine(window => window.start < window.end, 'start must precede end').nullable(),
  period: z.enum(['30d', '90d', '1y']).nullable(),
  grain: z.enum(['day', 'week', 'month', 'year']).nullable(),
  metric: z.enum(metricIds).nullable(),
  subject: scopeLabel.nullable(),
}).strict();
const progressStages = ['planning', 'checking', 'running', 'repairing', 'explaining', 'looking_up', 'reading'];
const chatRequestSchema = z.object({
  question: z.string().trim().min(1).max(1000),
  page: z.enum(pageIds),
  context: analysisSchema.nullable(),
  transaction: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  block: z.string().regex(/^(?:0|[1-9]\d{0,8}|[a-fA-F0-9]{64})$/).optional(),
  locale: z.enum(['auto', ...locales]).default('auto'),
  history: z.array(z.string().trim().min(1).max(1000)).max(4).default([]),
  currentAnalytics: querySchema.optional(),
  currentResearch: sqlQuerySchema.optional(),
  turnScope: turnScopeSchema.optional(),
  challenge: z.string().max(2048).optional(),
}).strict();
module.exports = { chatRequestSchema, turnScopeSchema, scopePools, progressStages, locales };
