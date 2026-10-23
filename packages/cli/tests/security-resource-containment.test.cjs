// Supplemental real-source/real-HTTP regression, not a replacement for yarn verify.
// APPMAP_TEST_SUPPORT=/absolute/existing/node_modules node --test <this file>
// No installation or build. Only unrelated progress/log/browser-open collaborators
// are inert; filesystem, URL handling, HTTP server and streams are the real Node APIs.
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { before, after, test } = require('node:test');

if (process.argv[2] === '--owned-server') {
  const support = process.env.APPMAP_TEST_SUPPORT;
  assert.ok(support && path.isAbsolute(support), 'Explicit existing support root required');
  const ts = require(path.join(support, 'typescript'));
  const source = path.resolve(__dirname, '../src/lib/serveAndOpen.ts');
  const emitted = ts.transpileModule(fs.readFileSync(source, 'utf8'), {
    fileName: source, reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  });
  assert.deepEqual(emitted.diagnostics, [], 'Transpile diagnostics; this is not project typechecking');
  const filename = path.join(process.env.APPMAP_TEST_RUNTIME, 'src/lib/serveAndOpen.cjs');
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.require = (name) => {
    if (name === '../utils') return { verbose: () => false };
    if (name === '../cmds/userInteraction') return { progress() {}, warn() {} };
    if (name === 'open') return () => { throw new Error('Browser opening is outside this test'); };
    assert.ok(['fs', 'http', 'net', 'path', 'url'].includes(name), `Unexpected source import ${name}`);
    return require(name);
  };
  loaded._compile(emitted.outputText, filename);
  process.once('disconnect', () => process.exit(0));
  loaded.exports.default('appmap.html', {}, process.env.APPMAP_TEST_VERIFY === 'true', (url) => {
    process.send({ url, typescript: ts.version });
  }, false);
} else {
  let scratch, root, sibling, outside, runtime;
  const servers = [];
  async function stop(cp) {
    if (cp.exitCode !== null || cp.signalCode !== null) return;
    const exited = once(cp, 'exit');
    cp.kill('SIGTERM');
    const kill = setTimeout(() => cp.kill('SIGKILL'), 1000);
    let deadline;
    try {
      await Promise.race([exited, new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error('Owned test server did not exit')), 3000);
      })]);
    } finally { clearTimeout(kill); clearTimeout(deadline); }
  }
  async function start(verify) {
    const cp = fork(__filename, ['--owned-server'], {
      cwd: root, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { PATH: process.env.PATH, APPMAP_TEST_SUPPORT: process.env.APPMAP_TEST_SUPPORT,
        APPMAP_TEST_RUNTIME: runtime, APPMAP_TEST_VERIFY: String(verify), HOME: scratch, TMPDIR: scratch },
    });
    servers.push(cp);
    let errors = '';
    cp.stderr.on('data', (bytes) => { errors += bytes; });
    cp.diagnostic = () => errors;
    cp.stdout.resume();
    let timer;
    try {
      const info = await Promise.race([
        once(cp, 'message').then(([value]) => value),
        once(cp, 'exit').then(([code]) => { throw new Error(`Server startup exit ${code}: ${errors}`); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Server startup timeout: ${errors}`)), 5000); }),
      ]);
      const base = new URL(info.url); base.hostname = '127.0.0.1';
      return base;
    } finally { clearTimeout(timer); }
  }
  function request(base, pathname) {
    const url = new URL(pathname, base);
    assert.equal(url.hostname, '127.0.0.1');
    return new Promise((resolve, reject) => {
      const req = http.get(url, { agent: false }, (res) => {
        const chunks = [];
        res.on('data', (bytes) => chunks.push(bytes)); res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, mime: res.headers['content-type'], body: Buffer.concat(chunks).toString() }));
      });
      req.setTimeout(3000, () => req.destroy(new Error('Loopback response timeout')));
      req.on('error', reject);
    });
  }
  const resource = (name) => `/resource?${encodeURIComponent(name)}`;
  let guarded, unrestricted;
  before(async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'appmap-containment-'));
    root = path.join(scratch, 'root'); sibling = path.join(scratch, 'root-neighbor');
    outside = path.join(scratch, 'outside'); runtime = path.join(scratch, 'runtime');
    for (const dir of [root, sibling, outside, path.join(root, 'nested'), path.join(runtime, 'built/html/nested')]) fs.mkdirSync(dir, { recursive: true });
    for (const [file, body] of [
      [path.join(root, 'inside.json'), '{"inside":true}'],
      [path.join(root, 'nested', 'inside.json'), '{"nested":true}'],
      [path.join(sibling, 'outside.json'), '{"ownedSibling":true}'],
      [path.join(outside, 'outside.json'), '{"ownedOutside":true}'],
      [path.join(runtime, 'built/html', 'appmap.html'), '<html>owned viewer fixture</html>'],
      [path.join(runtime, 'built/html', 'appmap.js'), '/* owned JavaScript */'],
      [path.join(runtime, 'built/html', 'appmap.css'), '/* owned CSS */'],
      [path.join(runtime, 'built/html', 'appmap.js.map'), '{}'],
    ]) fs.writeFileSync(file, body);
    fs.symlinkSync(path.join(outside, 'outside.json'), path.join(root, 'escape.json'));
    fs.symlinkSync(outside, path.join(root, 'escape-dir'), 'dir');
    fs.symlinkSync(path.join(root, 'inside.json'), path.join(root, 'inside-link.json'));
    fs.symlinkSync(path.join(outside, 'outside.json'), path.join(runtime, 'built/html', 'escape.json'));
    guarded = await start(true); unrestricted = await start(false);
  });
  after(async () => {
    // Cleanup only these owned processes/fixtures. Retain fixtures if any join fails.
    await Promise.all(servers.map(stop));
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  });
  test('Given existing contained files, when guarded resources/assets are requested, then bytes and MIME are preserved', async () => {
    for (const [name, mime, body] of [
      [resource('inside.json'), 'application/json', '{"inside":true}'],
      [resource(path.join(root, 'inside.json')), 'application/json', '{"inside":true}'],
      [resource('nested/inside.json'), 'application/json', '{"nested":true}'],
      [resource('nested/../inside.json'), 'application/json', '{"inside":true}'],
      ['/', 'text/html', '<html>owned viewer fixture</html>'],
      ['/appmap.js', 'application/javascript', '/* owned JavaScript */'],
      ['/appmap.css', 'text/css', '/* owned CSS */'],
      ['/appmap.js.map', 'application/json', '{}'],
    ]) assert.deepEqual(await request(guarded, name), { status: 200, mime, body });
  });
  test('Given verifyInSubdir=false, when an owned external resource is requested, then explicitly unrestricted behavior is preserved', async () => {
    for (const name of [path.join(outside, 'outside.json'), 'escape.json']) {
      assert.deepEqual(await request(unrestricted, resource(name)), { status: 200, mime: 'application/json', body: '{"ownedOutside":true}' });
    }
  });
  for (const [scenario, target] of [
    ['prefix-sibling traversal', () => '../root-neighbor/outside.json'],
    ['absolute prefix sibling', () => path.join(sibling, 'outside.json')],
    ['ordinary parent traversal', () => '../outside/outside.json'],
    ['absolute outside path', () => path.join(outside, 'outside.json')],
    ['outside file symlink', () => 'escape.json'],
    ['outside directory symlink', () => 'escape-dir/outside.json'],
    ['missing file', () => 'missing.json'],
  ]) test(`Given ${scenario}, when verifyInSubdir=true serves a resource, then return 404 without disclosing owned outside bytes`, async () => {
    const response = await request(guarded, resource(target()));
    assert.equal(response.status, 404); assert.equal(response.body, '');
  });
  test('Given an escaping static-asset symlink, when verifyInSubdir=true serves it, then return 404', async () => {
    assert.equal((await request(guarded, '/escape.json')).status, 404);
  });
  test('Given a symlink whose target remains inside the root, when guarded, then preserve contained resource behavior', async () => {
    assert.deepEqual(await request(guarded, resource('inside-link.json')), { status: 200, mime: 'application/json', body: '{"inside":true}' });
  });
  for (const verify of [true, false]) {
    for (const [kind, target] of [['resource', resource('nested')], ['static', '/nested']]) {
      test(`Given a contained ${kind} directory with verify=${verify}, when requested, then return 404 and keep serving real files`, async () => {
        // A fresh owned server per case keeps an old crash from masking later cases.
        const base = await start(verify), cp = servers.at(-1);
        const outcome = await request(base, target).catch((error) => ({ transportError: error.code }));
        const alive = await request(base, '/appmap.js').catch((error) => ({ transportError: error.code }));
        console.log(JSON.stringify({ kind, verify, directory: outcome, subsequentFile: alive, childExit: cp.exitCode, diagnostic: cp.diagnostic() }));
        assert.equal(outcome.status, 404, JSON.stringify(outcome));
        assert.equal(outcome.body, '');
        assert.equal(alive.status, 200, JSON.stringify(alive));
        assert.equal(cp.exitCode, null, cp.diagnostic());
      });
    }
  }
}
