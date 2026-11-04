/* eslint-disable @typescript-eslint/no-require-imports */
const { z } = require('zod');
const { analysisSchema } = require('./contract');
const { querySchema } = require('./query-contract');
const { sqlQuerySchema } = require('./research-contract');
const { pageIds } = require('./pages');
const locales = ['en', 'fr', 'es', 'de', 'pt', 'ja', 'zh', 'ko', 'ar', 'ru'];
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
  challenge: z.string().max(2048).optional(),
}).strict();
module.exports = { chatRequestSchema, locales };
