// Supplemental real-source/real-HTTP regression, not a replacement for yarn verify.
// APPMAP_TEST_SUPPORT=/absolute/existing/node_modules node --test <this file>
// No installation or build. Only unrelated progress/log/browser-open collaborators
// are inert; URL handling/HTTP server are real Node APIs. Selected owned fixtures
// additionally inject read/open faults or delay reads on real fs.ReadStreams.
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
  const observedStreams = [];
  let releaseOpen;
  const notify = (message) => { if (process.connected) process.send(message); };
  function faultStream(file, options) {
    const name = path.basename(file);
    const mode = process.env.APPMAP_TEST_STREAM_FAULT;
    if (!mode || name !== 'stream-fixture.bin') return fs.createReadStream(file, options);
    const injected = () => Object.assign(new Error(`owned fixture ${mode}`), { code: 'EIO' });
    let reads = 0;
    const io = { ...fs,
      open(file, flags, permissions, callback) {
        if (mode === 'before-open') return setImmediate(() => callback(injected()));
        if (mode === 'disconnect-before-open') {
          releaseOpen = () => fs.open(file, flags, permissions, callback);
          notify({ kind: 'stream', event: 'open-held' });
          return;
        }
        return fs.open(file, flags, permissions, callback);
      },
      read(fd, buffer, offset, length, position, callback) {
        reads++;
        if (mode === 'after-open' || (mode === 'after-data' && reads > 1)) return setImmediate(() => callback(injected()));
        return fs.read(fd, buffer, offset, length, position, callback);
      },
    };
    const stream = fs.createReadStream(file, { ...options, highWaterMark: 4096, fs: io });
    observedStreams.push(stream);
    notify({ kind: 'stream', event: 'created' });
    stream.on('open', () => notify({ kind: 'stream', event: 'open', fd: stream.fd }));
    stream.once('data', (bytes) => {
      // Stop future reads, without leaving a pending filesystem callback. This
      // makes disconnect cleanup observable rather than racing normal EOF.
      if (mode === 'disconnect-after-data') stream._read = () => {};
      notify({ kind: 'stream', event: 'data', bytes: bytes.length });
    });
    stream.on('error', (error) => notify({ kind: 'stream', event: 'error', code: error.code }));
    stream.on('close', () => notify({ kind: 'stream', event: 'close', closed: stream.closed, destroyed: stream.destroyed, fd: stream.fd }));
    return stream;
  }
  process.on('message', (message) => {
    if (message?.query === 'streams') notify({ kind: 'snapshot', token: message.token,
      streams: observedStreams.map((stream) => ({ closed: stream.closed, destroyed: stream.destroyed, fd: stream.fd, paused: stream.isPaused() })) });
  });
  loaded.require = (name) => {
    if (name === 'fs') return { ...fs, createReadStream: faultStream };
    if (name === 'http') return { ...http, createServer(listener) {
      return http.createServer((req, res) => {
        listener(req, res);
        res.once('close', () => {
          if (releaseOpen) {
            notify({ kind: 'stream', event: 'response-close-before-open' });
            const release = releaseOpen; releaseOpen = undefined; release();
          }
        });
      });
    } };
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
  async function start(verify, streamFault = '') {
    const cp = fork(__filename, ['--owned-server'], {
      cwd: root, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { PATH: process.env.PATH, APPMAP_TEST_SUPPORT: process.env.APPMAP_TEST_SUPPORT,
        APPMAP_TEST_RUNTIME: runtime, APPMAP_TEST_VERIFY: String(verify), APPMAP_TEST_STREAM_FAULT: streamFault, HOME: scratch, TMPDIR: scratch },
    });
    servers.push(cp);
    let errors = '';
    cp.stderr.on('data', (bytes) => { errors += bytes; });
    cp.diagnostic = () => errors;
    cp.streamEvents = [];
    cp.on('message', (message) => { if (message?.kind === 'stream') cp.streamEvents.push(message); });
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
  function streamState(cp) {
    return new Promise((resolve, reject) => {
      const token = `${Date.now()}-${Math.random()}`;
      const timer = setTimeout(() => { cp.off('message', receive); reject(new Error('Stream state timeout')); }, 1000);
      function receive(message) {
        if (message?.kind !== 'snapshot' || message.token !== token) return;
        clearTimeout(timer); cp.off('message', receive); resolve(message.streams);
      }
      cp.on('message', receive); cp.send({ query: 'streams', token });
    });
  }
  async function waitStreamClosed(cp) {
    let state;
    for (let attempt = 0; attempt < 50; attempt++) {
      state = await streamState(cp);
      if (state.length === 1 && state[0].closed && state[0].destroyed && state[0].fd === null) return state;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return state;
  }
  function streamRequest(base, disconnect = false) {
    return new Promise((resolve) => {
      let status, bytes = 0, settled = false, timedOut = false;
      const finish = (extra) => { if (!settled) { settled = true; resolve({ status, bytes, ...extra, timedOut }); } };
      const req = http.get(new URL(resource('stream-fixture.bin'), base), { agent: false }, (res) => {
        status = res.statusCode;
        res.on('data', (chunk) => { bytes += chunk.length; if (disconnect) res.destroy(); });
        res.on('end', () => finish({ complete: res.complete }));
        res.on('aborted', () => finish({ complete: false, transportError: 'aborted' }));
        res.on('error', (error) => finish({ complete: false, transportError: error.code }));
      });
      req.setTimeout(3000, () => { timedOut = true; req.destroy(new Error('Stream response timeout')); });
      req.on('error', (error) => finish({ complete: false, transportError: error.code || error.message }));
    });
  }
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
    fs.writeFileSync(path.join(root, 'stream-fixture.bin'), Buffer.alloc(128 * 1024, 'x'));
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
  for (const mode of ['before-open', 'after-open', 'after-data']) {
    test(`Given injected EIO ${mode}, when real HTTP streams a contained fixture, then report failure without killing the server`, async () => {
      const base = await start(true, mode), cp = servers.at(-1);
      const result = await streamRequest(base);
      const alive = await request(base, '/appmap.js').catch((error) => ({ transportError: error.code }));
      console.log(JSON.stringify({ mode, result, alive, events: cp.streamEvents, diagnostic: cp.diagnostic() }));
      assert.equal(alive.status, 200, cp.diagnostic());
      if (mode === 'before-open') { assert.equal(result.status, 404); assert.equal(result.complete, true); }
      else {
        assert.equal(result.complete, false);
        assert.equal(result.timedOut, false, 'Client timeout must not masquerade as server termination');
        assert.ok(['ECONNRESET', 'aborted'].includes(result.transportError), JSON.stringify(result));
      }
      if (mode === 'after-data') assert.ok(result.bytes > 0, 'Fault must follow actual body bytes');
      assert.ok(cp.streamEvents.some((event) => event.event === 'error' && event.code === 'EIO'));
      const state = await waitStreamClosed(cp);
      assert.deepEqual(state.map(({ closed, destroyed, fd }) => ({ closed, destroyed, fd })), [{ closed: true, destroyed: true, fd: null }]);
    });
  }
  test('Given a client disconnect after data, when the real response closes, then destroy and close the owned paused file stream', async () => {
    const base = await start(true, 'disconnect-after-data'), cp = servers.at(-1);
    const result = await streamRequest(base, true);
    assert.ok(result.bytes > 0); assert.equal(result.complete, false);
    const state = await waitStreamClosed(cp);
    console.log(JSON.stringify({ mode: 'disconnect-after-data', result, state, events: cp.streamEvents }));
    assert.deepEqual(state.map(({ closed, destroyed, fd }) => ({ closed, destroyed, fd })), [{ closed: true, destroyed: true, fd: null }]);
    assert.equal((await request(base, '/appmap.js')).status, 200);
  });
  test('Given a client disconnect before delayed open, when opening settles, then the owned file descriptor closes', async () => {
    const base = await start(true, 'disconnect-before-open'), cp = servers.at(-1);
    const req = http.get(new URL(resource('stream-fixture.bin'), base), { agent: false });
    req.on('error', () => {});
    try {
      for (let attempt = 0; attempt < 100 && !cp.streamEvents.some((event) => event.event === 'open-held'); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.ok(cp.streamEvents.some((event) => event.event === 'open-held'));
      assert.equal(cp.streamEvents.some((event) => event.event === 'open'), false);
      req.destroy();
      const state = await waitStreamClosed(cp);
      console.log(JSON.stringify({ mode: 'disconnect-before-open', state, events: cp.streamEvents }));
      const closeIndex = cp.streamEvents.findIndex((event) => event.event === 'response-close-before-open');
      const openIndex = cp.streamEvents.findIndex((event) => event.event === 'open');
      assert.ok(closeIndex >= 0 && openIndex > closeIndex, 'Server disconnect must precede released open');
      assert.deepEqual(state.map(({ closed, destroyed, fd }) => ({ closed, destroyed, fd })), [{ closed: true, destroyed: true, fd: null }]);
      assert.equal((await request(base, '/appmap.js')).status, 200);
    } finally { req.destroy(); }
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
