// Plain Node/npm contract; no installs, build, lifecycle scripts or publication.
// Default: inspect this checkout's built artifacts. For a reconstructed local pack,
// APPMAP_PACK_ASSETS explicitly selects existing immutable published built/resources.
// Such a run proves packing only, NOT a current-source build or publish-ready release.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { before, after, test } = require('node:test');
const packageRoot = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json')));
const assets = fs.realpathSync(process.env.APPMAP_PACK_ASSETS || packageRoot);
const reconstructed = assets !== fs.realpathSync(packageRoot);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
let scratch, archive, packedManifest, members, metadata, originalFiles;
function npmInvocation(platform = process.platform, node = process.execPath, cli = process.env.APPMAP_NPM_CLI) {
  // Windows npm.cmd is not directly executable without a shell. Standard Node
  // installs ship this JS entry; nonstandard installs can specify APPMAP_NPM_CLI.
  if (platform === 'win32' || cli) {
    const paths = platform === 'win32' ? path.win32 : path;
    const entry = cli || paths.join(paths.dirname(node), 'node_modules/npm/bin/npm-cli.js');
    assert.ok(paths.isAbsolute(entry), 'APPMAP_NPM_CLI must be absolute');
    return { file: node, args: [entry] };
  }
  return { file: 'npm', args: [] };
}
test('Given Windows npm.cmd, when forming the pack invocation, then use the JS CLI through Node without a shell', () => {
  assert.deepEqual(npmInvocation('win32', 'C:\\Program Files\\nodejs\\node.exe', ''), {
    file: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'],
  });
  assert.deepEqual(npmInvocation('win32', 'C:\\node.exe', 'D:\\tools\\npm-cli.js'), {
    file: 'C:\\node.exe', args: ['D:\\tools\\npm-cli.js'],
  });
});
function inventory(root, prefix = '') {
  return fs.readdirSync(path.join(root, prefix)).flatMap((name) => {
    const relative = `${prefix}${name}`;
    const file = path.join(root, relative), stat = fs.lstatSync(file);
    assert.ok(!stat.isSymbolicLink(), `Unexpected asset symlink: ${relative}`);
    if (stat.isDirectory()) return inventory(root, `${relative}/`);
    assert.ok(stat.isFile(), `Non-regular asset: ${relative}`);
    return [{ path: relative, sha256: sha(fs.readFileSync(file)) }];
  });
}
function noPhantomBundles(value) {
  assert.equal(Object.hasOwn(value, 'bundledDependencies'), false,
    'Compiled viewer assets must not claim nonexistent bundled package directories');
  assert.equal(Object.hasOwn(value, 'bundleDependencies'), false,
    'The alias must not restore a phantom bundled-directory claim');
}
before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'appmap-pack-contract-'));
  console.log(`Local pack scratch: ${scratch}`);
  const stage = path.join(scratch, 'stage'), out = path.join(scratch, 'out');
  for (const dir of [stage, out, path.join(scratch, 'home')]) fs.mkdirSync(dir);
  originalFiles = ['built', 'resources'].flatMap((dir) => inventory(assets, `${dir}/`));
  assert.ok(originalFiles.length > 0, 'Existing built/resource bytes required; do not silently substitute fixtures');
  for (const dir of ['built', 'resources']) fs.cpSync(path.join(assets, dir), path.join(stage, dir), { recursive: true });
  for (const name of ['LICENSE', 'LICENSE.txt', 'CHANGELOG.md', 'README.md']) {
    if (fs.existsSync(path.join(assets, name))) fs.copyFileSync(path.join(assets, name), path.join(stage, name));
  }
  fs.copyFileSync(path.join(packageRoot, 'package.json'), path.join(stage, 'package.json'));
  const npm = npmInvocation();
  const stdout = execFileSync(npm.file, [...npm.args, 'pack', '.', '--json', '--ignore-scripts', '--offline', '--workspaces=false',
    '--cache', path.join(scratch, 'npm-cache'), '--pack-destination', out], {
    cwd: stage, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      HOME: path.join(scratch, 'home'), USERPROFILE: path.join(scratch, 'home'), TMPDIR: scratch, TMP: scratch, TEMP: scratch,
      npm_config_userconfig: path.join(scratch, 'empty.npmrc'), npm_config_audit: 'false', npm_config_fund: 'false',
      npm_config_update_notifier: 'false' },
  });
  fs.writeFileSync(path.join(scratch, 'pack-stdout.json'), `${stdout}\n`);
  const packed = JSON.parse(stdout);
  // npm <=11 emits an array; npm12 emits a package-name-keyed object.
  if (Array.isArray(packed)) { assert.equal(packed.length, 1); [metadata] = packed; }
  else { assert.deepEqual(Object.keys(packed), [manifest.name]); metadata = packed[manifest.name]; }
  assert.equal(metadata.name, manifest.name);
  assert.equal(path.basename(metadata.filename), metadata.filename, 'Pack output must stay in owned scratch');
  archive = path.join(out, metadata.filename);
  assert.ok(fs.statSync(archive).size > 0, 'Actual tgz required; dry-run metadata is not a pack');
  const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  members = listing.trim().split('\n');
  assert.ok(members.every((name) => name.startsWith('package/') && !name.split('/').includes('..')));
  assert.equal(new Set(members).size, members.length, 'Duplicate archive members are ambiguous');
  const unpacked = path.join(scratch, 'unpacked'); fs.mkdirSync(unpacked);
  execFileSync('tar', ['-xzf', archive, '-C', unpacked], { timeout: 30000 });
  packedManifest = JSON.parse(fs.readFileSync(path.join(unpacked, 'package/package.json')));
  fs.writeFileSync(path.join(scratch, 'pack-metadata.json'), `${stdout}\n`);
  fs.writeFileSync(path.join(scratch, 'archive-members.txt'), listing);
  fs.writeFileSync(path.join(scratch, 'source-assets.json'), `${JSON.stringify(originalFiles, null, 2)}\n`);
  console.log(JSON.stringify({ evidence: scratch, archive, archiveSHA256: sha(fs.readFileSync(archive)),
    sourceManifestSHA256: sha(fs.readFileSync(path.join(packageRoot, 'package.json'))),
    sourceAssets: assets, reconstructed, currentSourceBuildProven: false, installationOrPublication: false,
    memberCount: members.length, preservedBuiltResourceFiles: originalFiles.length,
    qualification: reconstructed ? 'Reconstructed local pack from existing published assets plus current source manifest; not rebuilt release' : 'Existing checkout build bytes; this test does not perform or prove a build' }));
});
after(() => {
  if (scratch && process.env.APPMAP_PACK_KEEP !== '1') fs.rmSync(scratch, { recursive: true, force: true });
});
test('Given the source manifest, when compiled-assets-only packaging is selected, then no phantom bundled-directory declarations remain', () => {
  noPhantomBundles(manifest);
  for (const name of ['@appland/components', '@appland/diagrams']) {
    assert.equal(typeof manifest.dependencies[name], 'string', `Preserve runtime dependency ${name}`);
  }
});
test('Given an actual local pack, when its manifest and inventory are read, then no phantom bundled folders are promised', () => {
  noPhantomBundles(packedManifest);
  assert.ok(!members.some((name) => name.startsWith('package/node_modules/')));
  assert.deepEqual(metadata.files.map((file) => `package/${file.path}`).sort(), [...members].sort());
});
test('Given existing built viewer and resource bytes, when packed, then all files survive byte-for-byte', () => {
  for (const file of originalFiles) {
    assert.ok(members.includes(`package/${file.path}`), `Missing ${file.path}`);
    assert.equal(sha(fs.readFileSync(path.join(scratch, 'unpacked/package', file.path))), file.sha256, file.path);
  }
  for (const file of ['built/cli.js', 'built/html/appmap.html', 'built/html/appmap.js', 'built/html/appmap.css',
    'built/html/sequenceDiagram.html', 'built/html/sequenceDiagram.js', 'built/html/sequenceDiagram.css']) {
    assert.ok(members.includes(`package/${file}`), `Missing executable/viewer ${file}`);
  }
  for (const license of ['LICENSE', 'LICENSE.txt']) {
    if (fs.existsSync(path.join(assets, license))) {
      assert.ok(members.includes(`package/${license}`), `Preserve ${license}`);
      assert.equal(sha(fs.readFileSync(path.join(scratch, 'unpacked/package', license))), sha(fs.readFileSync(path.join(assets, license))));
    }
  }
});
test('Given runtime dependencies and release metadata, when packed without scripts, then source declarations are preserved', () => {
  for (const field of ['name', 'version', 'dependencies', 'optionalDependencies', 'engines', 'files', 'scripts', 'pkg', 'publishConfig']) {
    assert.deepEqual(packedManifest[field], manifest[field], field);
  }
  const bin = typeof packedManifest.bin === 'string' ? packedManifest.bin : packedManifest.bin.appmap;
  assert.equal(bin, 'built/cli.js');
});
