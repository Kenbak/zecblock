/**
 * OpenAPI generation + drift tests.
 *
 * Run: node --test server/api/test/v1/openapi.test.js
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const { buildOpenApiDocument, toOpenApiPath } = require('../../v1/openapi');
const { MANIFEST } = require('../../v1/inventory/manifest');

const YAML_PATH = path.join(__dirname, '..', '..', 'openapi', 'v1.yaml');

test('server/api/openapi/v1.yaml exists and is valid YAML', () => {
  assert.ok(fs.existsSync(YAML_PATH), 'expected server/api/openapi/v1.yaml to exist — run `node server/api/v1/tools/write-openapi.js`');
  const raw = fs.readFileSync(YAML_PATH, 'utf8');
  const parsed = yaml.load(raw);
  assert.ok(parsed, 'YAML failed to parse');
});

test('committed v1.yaml matches what the generator produces from the current manifest (no drift)', () => {
  const raw = fs.readFileSync(YAML_PATH, 'utf8');
  const committed = yaml.load(raw);
  const generated = buildOpenApiDocument();
  assert.deepEqual(
    committed,
    generated,
    'server/api/openapi/v1.yaml is out of sync with the manifest — run `node server/api/v1/tools/write-openapi.js` and commit the result'
  );
});

test('document is a well-formed OpenAPI 3.1 document with the required top-level members', () => {
  const doc = buildOpenApiDocument();
  assert.equal(doc.openapi, '3.1.0');
  assert.ok(doc.info?.title);
  assert.ok(doc.info?.version);
  assert.ok(Object.keys(doc.paths).length > 0);
  assert.ok(doc.components?.schemas?.Problem);
  assert.ok(doc.components?.schemas?.Meta);
});

test('every mounted manifest entry (adapter or stub) has a corresponding OpenAPI operation', () => {
  const doc = buildOpenApiDocument();
  for (const entry of MANIFEST) {
    if (entry.v1.status === 'excluded') continue;
    const contractPath = toOpenApiPath(entry.v1.path);
    const pathItem = doc.paths[contractPath];
    assert.ok(pathItem, `missing OpenAPI path item for ${entry.v1.path}`);
    const op = pathItem[entry.method.toLowerCase()];
    assert.ok(op, `missing OpenAPI operation for ${entry.method} ${entry.v1.path}`);
    assert.equal(op['x-cipherscan-legacy-path'], entry.legacyPath);
    assert.equal(op['x-cipherscan-v1-status'], entry.v1.status);
  }
});

test('path parameters use OpenAPI braces and server URLs do not duplicate /v1', () => {
  const doc = buildOpenApiDocument();
  assert.ok(doc.paths['/v1/blocks/{heightOrHash}']);
  assert.equal(Object.keys(doc.paths).some((routePath) => routePath.includes(':')), false);
  assert.equal(doc.servers.some(({ url }) => url.endsWith('/v1')), false);
  assert.equal(doc.servers[0].url, 'https://api.zecblock.com');
});

test('public reads do not declare a global preview-key requirement', () => {
  const doc = buildOpenApiDocument();
  assert.equal(doc.security, undefined);
  assert.equal(doc.components.securitySchemes?.previewKey, undefined);
  const published = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'public', 'openapi-v1.json'), 'utf8'));
  assert.equal(published.security, undefined);
  assert.equal(published.components.securitySchemes?.previewKey, undefined);
});

test('no OpenAPI path is emitted for an excluded manifest entry', () => {
  const doc = buildOpenApiDocument();
  for (const entry of MANIFEST) {
    if (entry.v1.status !== 'excluded') continue;
    // An excluded entry's legacy path should never appear as a v1 path
    // (defensive — it wouldn't share the /v1 prefix anyway).
    for (const v1Path of Object.keys(doc.paths)) {
      assert.notEqual(v1Path, entry.legacyPath);
    }
  }
});

test('every operation exposes a 501 (stub) or 200+error-family (adapter) response set', () => {
  const doc = buildOpenApiDocument();
  for (const [routePath, methods] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (op['x-cipherscan-v1-status'] === 'stub') {
        assert.ok(op.responses['501'], `${method.toUpperCase()} ${routePath}: stub op missing 501 response`);
      } else {
        assert.ok(op.responses['200'], `${method.toUpperCase()} ${routePath}: adapter op missing 200 response`);
        assert.ok(op.responses['404'], `${method.toUpperCase()} ${routePath}: adapter op missing 404 response`);
      }
    }
  }
});
