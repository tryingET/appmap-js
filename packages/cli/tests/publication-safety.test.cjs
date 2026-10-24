const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const root = path.resolve(__dirname, '../../..');
const cli = path.resolve(__dirname, '..');

test('release-published manifests and npm tags remain upstream-only', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/manifests.yml'), 'utf8');
  const condition = workflow.match(/^ {2}setup:\n {4}if: (.+)$/m)?.[1];
  assert.equal(condition, "github.repository == 'getappmap/appmap-js'");
  for (const repository of ['tryingET/appmap-js', 'getappmap/appmap-js']) {
    assert.equal(
      condition === `github.repository == '${repository}'`,
      repository === 'getappmap/appmap-js'
    );
  }
  for (const job of ['npm', 'manifests']) {
    const section = workflow.split(`  ${job}:\n`)[1]?.split(/^ {2}[a-z_]+:\n/m)[0];
    assert.ok(section?.includes('    needs: [setup]'), `${job} must depend on upstream-only setup`);
  }
});

test('official release requires both upstream ownership and main', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/main.yml'), 'utf8');
  const condition = workflow.match(/^ {2}release:\n {4}if: (.+)$/m)?.[1];
  assert.equal(
    condition,
    "github.ref == 'refs/heads/main' && github.repository == 'getappmap/appmap-js'"
  );
  const clauses = condition.split(' && ').map((clause) => {
    const match = /^github\.(ref|repository) == '([^']+)'$/.exec(clause);
    assert.ok(match, 'Only explicit equality clauses are supported');
    return match.slice(1);
  });
  const eligible = (ref, repository) =>
    clauses.every(([key, value]) => ({ ref, repository }[key] === value));
  assert.equal(eligible('refs/heads/main', 'tryingET/appmap-js'), false);
  assert.equal(eligible('refs/heads/main', 'getappmap/appmap-js'), true);
  assert.equal(eligible('refs/heads/feature', 'getappmap/appmap-js'), false);
  assert.equal(eligible('refs/tags/test', 'getappmap/appmap-js'), false);
  for (const job of [
    'test_cli',
    'test_components',
    'test_native',
    'test_scanner',
    'test_the_rest',
  ]) {
    assert.ok(workflow.includes(`  ${job}:\n`), `Preserve ${job}`);
  }
});

test('provider documentation uses obvious placeholders, never key-shaped examples', () => {
  const text = fs.readFileSync(
    path.join(root, 'docs/using-navie-ai/choose-llm-provider.md'),
    'utf8'
  );
  // Never put a matched credential-shaped value in assertion diagnostics.
  // The separate abbreviated provider-prefix illustration is not a full key.
  assert.equal(/\bsk-[A-Za-z0-9_-]{24,}/.test(text), false, 'Credential-shaped example found');
  assert.ok(text.includes('<your-openai-api-key>'));
  assert.ok(text.includes('<your-anthropic-api-key>'));
});

test('CLI explicitly packages its third-party notices', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(cli, 'package.json'), 'utf8'));
  assert.ok(manifest.files.includes('THIRD_PARTY_NOTICES.txt'));
  assert.ok(manifest.files.includes('third-party'));
  assert.ok(fs.existsSync(path.join(cli, 'THIRD_PARTY_NOTICES.txt')));
});
