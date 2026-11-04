const fs = require('node:fs');
const path = require('node:path');
const { MANIFEST } = require('../inventory/manifest');
const queryParameters = require('../inventory/query-parameters.json');
const { buildOpenApiDocument, toOpenApiPath } = require('../openapi');
function buildReference() {
  const spec = buildOpenApiDocument();
  return MANIFEST.filter(entry => entry.classification === 'public').map(entry => {
    const operation = spec.paths[toOpenApiPath(entry.v1.path)][entry.method.toLowerCase()];
    return {
      method: entry.method, path: entry.v1.path, description: entry.description,
      category: entry.domain, query: queryParameters[`${entry.method} ${entry.v1.path}`] || [],
      listKey: entry.v1.listKey || null, zatoshiFields: entry.v1.zatoshiFields || [],
      note: entry.v1.notes || entry.v1.description || null, ownershipToken: Boolean(entry.v1.forwardNodeToken),
      pagination: entry.v1.shape === 'list' || entry.v1.nativeKey === 'names' ? 'cursor' : null,
      parameters: operation.parameters || [],
      requestBody: operation.requestBody?.content['application/json'].schema || null,
    };
  });
}
function buildPublicSpec() {
  const spec = buildOpenApiDocument();
  spec.paths = Object.fromEntries(Object.entries(spec.paths).flatMap(([route, methods]) => {
    const publicMethods = Object.fromEntries(Object.entries(methods).filter(([, op]) => op['x-cipherscan-classification'] === 'public'));
    return Object.keys(publicMethods).length ? [[route, publicMethods]] : [];
  }));
  return spec;
}
if (require.main === module) {
  const root = path.resolve(__dirname, '../../../..');
  fs.mkdirSync(path.join(root, 'lib/generated'), { recursive: true });
  fs.writeFileSync(path.join(root, 'lib/generated/api-reference.json'), JSON.stringify(buildReference(), null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'public/openapi-v1.json'), JSON.stringify(buildPublicSpec(), null, 2) + '\n');
}
module.exports = { buildReference, buildPublicSpec };
