// Unit tests for BugRep's own plumbing (run with: npm test)
const { extractJson } = require('../workflow/engines');
const { classify } = require('../workflow/testrunner');
const { safeJoin } = require('../workflow/workspace');
const { parseGithubUrl } = require('../workflow/sources');

describe('extractJson', () => {
  test('finds the answer inside a wrapped JSON result', () => {
    const out = JSON.stringify({ type: 'result', result: 'Sure!\n```json\n{"files":[{"path":"a.js","content":"x"}]}\n```' });
    expect(extractJson(out, ['files']).files[0].path).toBe('a.js');
  });
  test('repairs raw newlines inside JSON strings', () => {
    const out = 'Here you go: {"testCode": "line1\nline2", "localizedFile": "a.js"} thanks';
    expect(extractJson(out, ['testCode']).testCode).toBe('line1\nline2');
  });
  test('reads NDJSON event streams', () => {
    const out = '{"type":"start"}\n{"type":"message","content":{"rootCause":"x","files":[]}}\n';
    expect(extractJson(out, ['files']).rootCause).toBe('x');
  });
  test('returns null when nothing matches', () => {
    expect(extractJson('no json here', ['files'])).toBe(null);
  });
});

describe('classify', () => {
  test('assertion failures count as a real failure', () => {
    expect(classify({ total: 2, failed: 1, suiteErrors: 0, tests: [{ status: 'failed', message: 'Expected: 0 Received: -10' }] })).toBe('fail');
  });
  test('a broken import is an error, not a reproduced bug', () => {
    expect(classify({ total: 1, failed: 1, suiteErrors: 0, tests: [{ status: 'failed', message: 'TypeError: calc is not a function' }] })).toBe('error');
  });
  test('zero tests executed is an error, never a pass', () => {
    expect(classify({ total: 0, failed: 0, suiteErrors: 0, tests: [] })).toBe('error');
  });
});

describe('safety', () => {
  test('safeJoin blocks path traversal', () => {
    expect(safeJoin('/tmp/ws', '../etc/passwd')).toBe(null);
    expect(safeJoin('/tmp/ws', '/etc/passwd')).toBe(null);
    expect(safeJoin('/tmp/ws', 'src/a.js')).toMatch(/src[\\/]a\.js$/);
  });
  test('parses GitHub URLs', () => {
    expect(parseGithubUrl('https://github.com/ibm/foo/tree/main/packages/bar')).toEqual({ owner: 'ibm', repo: 'foo', ref: 'main', subdir: 'packages/bar' });
    expect(parseGithubUrl('ibm/foo')).toMatchObject({ owner: 'ibm', repo: 'foo' });
  });
});
