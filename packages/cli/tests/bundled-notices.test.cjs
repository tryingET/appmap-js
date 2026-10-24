const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const { calculate, write, check } = require('../scripts/bundled-notices.cjs');
const { sha, resolveSource, packageRoot, legalFooter } = require('../scripts/notice-evidence.cjs');
const realRoot = path.resolve(__dirname, '../../..');

test('EPL recipients receive source availability terms and actual ELK Java retrieval locations', () => {
  const result = calculate(realRoot);
  assert.equal(result.inventory.sourceAvailability?.path, 'SOURCE_AVAILABILITY.md');
  const statement = fs.readFileSync(path.join(realRoot, 'packages/cli/third-party/SOURCE_AVAILABILITY.md'), 'utf8');
  assert.equal(sha(statement), result.inventory.sourceAvailability.sha256);
  for (const marker of ['source code form', 'EPL-1.0', 'EPL-2.0', 'https://github.com/eclipse-elk/elk', 'https://repo.maven.apache.org/maven2/', 'historical']) {
    assert.ok(statement.includes(marker), `Missing recipient information: ${marker}`);
  }
  assert.ok(result.notices.includes(statement));
});


function fixture() {
  const root = fs.mkdtempSync(path.join(process.env.RELEASE_EVIDENCE || os.tmpdir(), 'license-test-'));
  const cli = path.join(root, 'packages/cli');
  const put = (file, value) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const footer = '/*! Bundled license information:\n\nalpha/index.js:\n  (*! Copyright Alpha; MIT *)\n*/';
  put('node_modules/alpha/package.json', { name: 'alpha', version: '1.0.0', license: 'MIT' });
  put('node_modules/alpha/index.js', 'module.exports = 1;');
  put('node_modules/alpha/LICENSE', 'Copyright Alpha\nPermission is hereby granted, free of charge.\n');
  put('packages/cli/built/html/app.js', '(()=>{})();\n' + footer + '\n//# sourceMappingURL=app.js.map\n');
  put('packages/cli/built/html/app.js.map', {
    version: 3, sources: ['../../../../node_modules/alpha/index.js'],
    sourcesContent: ['module.exports = 1;'], names: [], mappings: '',
  });
  const policy = {
    schemaVersion: 1, packages: [{ root: 'node_modules/alpha', name: 'alpha', version: '1.0.0' }],
    footers: [{ asset: 'built/html/app.js', sha256: sha(footer) }],
    cssPackages: [], overrides: [], supplements: [], sourceExceptions: [], gaps: [],
  };
  put('packages/cli/third-party/policy.json', policy);
  return { root, cli, put, policy, clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function using(fn) { const f = fixture(); try { fn(f); } finally { f.clean(); } }

test('Given surplus packaged notice files, both generation and checking reject them', () => using(f => {
  const result = calculate(f.root); write(f.root, result);
  f.put('packages/cli/third-party/scratch.txt', 'not an approved public notice');
  assert.throws(() => check(f.root, result), /Unexpected notice file/);
  assert.throws(() => write(f.root, result), /Unexpected notice file/);
}));
test('Given autocrlf checkout, original pinned text bytes remain verbatim', () => using(f => {
  const repo = path.join(f.root, 'checkout-test');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'core.autocrlf=true', ...args], { stdio: 'pipe' });
  git('init');
  const attrs = path.join(realRoot, 'packages/cli/.gitattributes');
  fs.mkdirSync(path.join(repo, 'packages/cli/third-party/texts'), { recursive: true });
  if (fs.existsSync(attrs)) fs.copyFileSync(attrs, path.join(repo, 'packages/cli/.gitattributes'));
  const files = {
    'packages/cli/third-party/texts/lf.txt': 'Copyright\nPermission\n',
    'packages/cli/third-party/texts/crlf.txt': 'Copyright\r\nPermission\r\n',
    'packages/cli/third-party/policy.json': '{"sha":"pinned"}\n',
    'packages/cli/third-party/inventory.json': '{"sha":"derived"}\n',
    'packages/cli/THIRD_PARTY_NOTICES.txt': 'Verbatim text\n',
  };
  for (const [file, bytes] of Object.entries(files)) fs.writeFileSync(path.join(repo, file), bytes);
  git('add', '.');
  const out = path.join(f.root, 'checked-out'); fs.mkdirSync(out);
  git('checkout-index', '--all', `--prefix=${out}${path.sep}`);
  for (const [file, bytes] of Object.entries(files)) assert.equal(sha(fs.readFileSync(path.join(out, file))), sha(bytes), file);
}));

test('Given a nested scoped package, when resolving ownership, then preserve the innermost physical version', () => {
  assert.equal(packageRoot('/r/node_modules/a/node_modules/@scope/b/src/index.ts'), '/r/node_modules/a/node_modules/@scope/b');
  assert.equal(resolveSource('/r/packages/cli/built/html/x.js.map', '', '../../../../node_modules/a/index.js'), '/r/node_modules/a/index.js');
  assert.equal(resolveSource('/r/maps/a.map', '../src', 'a.ts'), '/r/src/a.ts');
  assert.throws(() => resolveSource('/r/a.map', '', 'https://example.invalid/a.ts'), /remote|URL/i);
});
test('Given an esbuild footer, when extracting, then copy only the exact legal block', () => {
  const block = '/*! Bundled license information:\na.js:\n  (*! MIT *)\n*/';
  assert.equal(legalFooter('minified code;\n' + block + '\n//# sourceMappingURL=x.map'), block);
  assert.throws(() => legalFooter('/*! Bundled license information: truncated'), /footer/i);
});
test('Given valid evidence, when generated twice, then outputs are deterministic and check is read-only', () => using(f => {
  const a = calculate(f.root); const b = calculate(f.root);
  assert.deepEqual(a, b); write(f.root, a); check(f.root, a);
  assert.match(a.notices, /Copyright Alpha/);
  assert.equal(a.inventory.packages.length, 1);
  assert.ok(a.inventory.legalRecords.some(r => r.kind === 'bundle-footer'));
}));
test('Given missing or corrupted notices, when checking, then fail rather than repair', () => using(f => {
  const result = calculate(f.root); write(f.root, result);
  fs.appendFileSync(path.join(f.cli, 'THIRD_PARTY_NOTICES.txt'), 'corrupt');
  assert.throws(() => check(f.root, result), /drift|different/i);
  fs.unlinkSync(path.join(f.cli, 'THIRD_PARTY_NOTICES.txt'));
  assert.throws(() => check(f.root, result), /missing|ENOENT/i);
}));
test('Given a missing installed license, when generating, then fail closed', () => using(f => {
  fs.unlinkSync(path.join(f.root, 'node_modules/alpha/LICENSE'));
  assert.throws(() => calculate(f.root), /license/i);
}));
test('Given an unknown package version, when generating, then fail closed', () => using(f => {
  f.put('node_modules/alpha/package.json', { name: 'alpha', version: '2.0.0', license: 'MIT' });
  assert.throws(() => calculate(f.root), /version|package|identity/i);
}));
test('Given an added unknown mapped package, when generating, then reject it even if licensed', () => using(f => {
  f.put('node_modules/beta/package.json', { name: 'beta', version: '1.0.0', license: 'MIT' });
  f.put('node_modules/beta/index.js', 'beta'); f.put('node_modules/beta/LICENSE', 'MIT');
  const map = JSON.parse(fs.readFileSync(path.join(f.cli, 'built/html/app.js.map')));
  map.sources.push('../../../../node_modules/beta/index.js'); map.sourcesContent.push('beta');
  f.put('packages/cli/built/html/app.js.map', map);
  assert.throws(() => calculate(f.root), /unknown|unapproved/i);
}));
test('Given a removed mapped package, when generating, then reject an incomplete coverage set', () => using(f => {
  f.put('packages/cli/built/html/app.js.map', { version: 3, sources: [], sourcesContent: [], names: [], mappings: '' });
  assert.throws(() => calculate(f.root), /missing|coverage|absent/i);
}));
test('Given changed or removed legal headers, when generating, then fail closed', () => using(f => {
  f.put('packages/cli/built/html/app.js', '/*! Bundled license information:\nChanged copyright\n*/');
  assert.throws(() => calculate(f.root), /footer|header/i);
  f.put('packages/cli/built/html/app.js', 'no footer');
  assert.throws(() => calculate(f.root), /footer|header/i);
}));
test('Given mismatched mapped source bytes, when generating, then do not infer an installed version', () => using(f => {
  f.put('node_modules/alpha/index.js', 'changed');
  assert.throws(() => calculate(f.root), /source|match/i);
}));
test('Given a pinned supplemental text, when its bytes change, then fail closed', () => using(f => {
  f.put('packages/cli/third-party/texts/pinned.txt', 'corrupt');
  f.policy.supplements.push({ id: 'pinned', license: 'MIT', texts: [{ path: 'texts/pinned.txt', sha256: sha('expected'), provenance: 'https://example.invalid/commit/LICENSE' }] });
  f.put('packages/cli/third-party/policy.json', f.policy);
  assert.throws(() => calculate(f.root), /hash|digest|pinned/i);
}));
test('Given actual distributed viewers, when inventoried, then all researched roots, footer records and explicit gaps survive', () => {
  const r = calculate(realRoot);
  const ids = new Set(r.inventory.packages.map(p => p.name + '@' + p.version));
  assert.equal(ids.size, 166);
  assert.equal(r.inventory.packages.length, 168);
  for (const id of ['react@18.3.1', 'tailwindcss@3.4.19', 'elkjs@0.9.3', 'mermaid@10.9.8', 'd3-array@2.12.1', 'd3-array@3.2.3', 'micromark@3.2.0']) assert.ok(ids.has(id), id);
  const lucide = r.inventory.packages.find(p => p.name === 'lucide-vue');
  assert.ok(lucide.sources.some(s => s.source.includes('/shared/src/utils.ts') && s.proof === 'upstream-map'));
  for (const text of ['js-yaml', 'web-worker', 'KaTeX', 'Zlib', 'EPL-1.0', 'EPL-2.0', 'decamelize']) assert.ok(r.notices.includes(text), text);
  assert.ok(r.inventory.gaps.some(g => /ELK/.test(g)));
  const supplementIds = new Set(r.inventory.supplements.map(s => s.id));
  for (const id of ['mermaid-embedded-js-yaml-4.1.0', 'elk-web-worker-shim', 'elk-upstream-copyrights', 'cytoscape-vendor-credits', 'katex-legacy-react', 'pako-zlib', 'decamelize-derived-cli', 'elk-guava', 'elk-guava-gwt', 'elk-gwt-user', 'elk-emf-common', 'elk-emf-ecore', 'elk-xbase', 'elk-xtend']) assert.ok(supplementIds.has(id), id);
  assert.ok(r.inventory.legalRecords.filter(x => x.kind === 'bundle-footer').length >= 5);
  assert.ok(r.inventory.packages.filter(x => x.licenseTexts.some(t => t.provenance)).length >= 18);
  assert.ok(r.inventory.legalRecords.every(x => x.sha256 && x.textId));
  check(realRoot, r);
});

test('Given missing distributed source maps, when generating, then reject unverifiable JS instead of silently omitting dependencies', () => using(f => {
  f.put('packages/cli/built/html/unmapped.js', 'vendoredUnknownLibrary();');
  assert.throws(() => calculate(f.root), /source.map|map evidence/i);
}));
test('Given a modified inventory or copied legal-text artifact, when checking, then fail without repairing it', () => using(f => {
  const r = calculate(f.root); write(f.root, r);
  fs.appendFileSync(path.join(f.cli, 'third-party/inventory.json'), ' ');
  assert.throws(() => check(f.root, r), /drift/i);
  write(f.root, r);
  const file = path.join(f.cli, 'third-party', Object.keys(r.textFiles)[0]);
  fs.appendFileSync(file, 'corrupt');
  assert.throws(() => check(f.root, r), /drift/i);
}));
test('Given a source-map escape outside the source installation, when resolving evidence, then reject it', () => using(f => {
  f.put('packages/cli/built/html/app.js.map', {version: 3, sources: ['../../../../../../outside.js'], sourcesContent: ['secret'], names: [], mappings: ''});
  assert.throws(() => calculate(f.root), /outside/i);
}));
test('Given original files absent but installed upstream maps present, when generating, then verify exact composed source content', () => using(f => {
  const original = 'export const original = 1;';
  f.put('node_modules/alpha/dist/index.js.map', {version: 3, sourceRoot: '', sources: ['../src/index.ts'], sourcesContent: [original], names: [], mappings: ''});
  f.put('packages/cli/built/html/app.js.map', {version: 3, sources: ['../../../../node_modules/alpha/src/index.ts'], sourcesContent: [original], names: [], mappings: ''});
  assert.equal(calculate(f.root).inventory.packages[0].sources[0].proof, 'upstream-map');
  f.put('node_modules/alpha/dist/index.js.map', {version: 3, sources: ['../src/index.ts'], sourcesContent: ['different'], names: [], mappings: ''});
  assert.throws(() => calculate(f.root), /Unresolved mapped source/);
}));
test('Given a Lucide-style escaped upstream source, when the explicit override is corrupted, then fail ownership verification', () => using(f => {
  const original = 'function sharedUtility() {}';
  const escaped = 'node_modules/shared/src/utils.ts';
  f.put('node_modules/alpha/dist/esm/shared/src/utils.js.map', {version: 3, sources: ['../../../../../shared/src/utils.ts'], sourcesContent: [original], names: [], mappings: ''});
  f.put('packages/cli/built/html/app.js.map', {version: 3, sources: ['../../../../node_modules/shared/src/utils.ts'], sourcesContent: [original], names: [], mappings: ''});
  f.policy.sourceOverrides = [{sourcePath: escaped, owner: 'node_modules/alpha', sha256: sha(original), upstreamMap: 'node_modules/alpha/dist/esm/shared/src/utils.js.map'}];
  f.put('packages/cli/third-party/policy.json', f.policy);
  assert.equal(calculate(f.root).inventory.packages[0].sources[0].proof, 'upstream-map');
  f.policy.sourceOverrides[0].sha256 = sha('wrong');
  f.put('packages/cli/third-party/policy.json', f.policy);
  assert.throws(() => calculate(f.root), /override hash/i);
}));
