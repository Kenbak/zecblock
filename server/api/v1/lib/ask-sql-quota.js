'use strict';
const { askError } = require('./ask-errors');
const { sqlQuotaSchema } = require('../../../../lib/ask/quota-contract');
function sqlQuotaError(code, retryAfter) {
  const value = sqlQuotaSchema.parse({ code, retryAfter });
  return Object.assign(askError('quota'), { quota: true, quotaCode: value.code, retryAfter: value.retryAfter });
}
function sqlQuotaDetails(error) {
  if (error?.quota !== true) return undefined;
  const value = sqlQuotaSchema.safeParse({ code: error.quotaCode, retryAfter: error.retryAfter });
  return value.success ? value.data : undefined;
}
module.exports = { sqlQuotaError, sqlQuotaDetails };
