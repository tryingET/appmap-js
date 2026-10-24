'use strict';
// No network, package execution, or build invocation: parse existing distribution evidence only.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { fileURLToPath } = require('node:url');
const assert = require('node:assert/strict');
const sha = value => createHash('sha256').update(value).digest('hex');
const posix = value => value.split(path.sep).join('/');
function inside(root, file) {
  const rel = path.relative(root, file);
  assert.ok(rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel), 'Path outside approved root');
  return file;
}
function read(root, file) {
  inside(root, file);
  inside(fs.realpathSync(root), fs.realpathSync(file));
  return fs.readFileSync(file);
}
function walk(root, skip = new Set()) {
  return fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    .flatMap(entry => {
      if (skip.has(entry.name)) return [];
      const file = path.join(root, entry.name);
      assert.ok(!entry.isSymbolicLink(), `Unexpected evidence symlink: ${file}`);
      return entry.isDirectory() ? walk(file, skip) : [file];
    });
}
function resolveSource(mapFile, sourceRoot, source) {
  assert.equal(typeof source, 'string', 'Invalid source-map source');
  const convert = value => {
    if (/^file:/i.test(value)) return fileURLToPath(value);
    assert.ok(!/^[a-z][a-z\d+.-]*:/i.test(value), 'Remote source URL requires explicit provenance');
    assert.ok(!value.includes('\\'), 'Ambiguous source-map separator');
    return value;
  };
  return path.resolve(path.dirname(mapFile), convert(sourceRoot || ''), convert(source));
}
function packageRoot(file) {
  const text = posix(file), marker = '/node_modules/', i = text.lastIndexOf(marker);
  if (i < 0) return undefined;
  const rest = text.slice(i + marker.length).split('/');
  const length = rest[0].startsWith('@') ? 2 : 1;
  assert.ok(rest.length >= length && rest.slice(0, length).every(Boolean), 'Invalid package source');
  return text.slice(0, i + marker.length) + rest.slice(0, length).join('/');
}
function legalFooter(text) {
  const marker = 'Bundled license information:', at = text.lastIndexOf(marker);
  if (at < 0) return null;
  const start = text.lastIndexOf('/*', at), end = text.indexOf('*/', at);
  assert.ok(start >= 0 && end >= at, 'Malformed legal footer');
  assert.ok(text.slice(start, at).trim() === '/*!' || text.slice(start, at).trim() === '/*', 'Ambiguous legal footer');
  assert.ok(/^\s*(?:\/\/# sourceMappingURL=[^\r\n]*\s*)?$/.test(text.slice(end + 2)), 'Legal footer must be terminal');
  return text.slice(start, end + 2);
}
function legalBlocks(text) {
  const footer = legalFooter(text), blocks = [];
  if (footer) blocks.push({ kind: 'bundle-footer', text: footer });
  for (const m of text.matchAll(/\/\*![\s\S]*?\*\//g)) {
    if (m[0] !== footer) blocks.push({ kind: 'legal-banner', text: m[0] });
  }
  // Vendored CLI code retains ordinary // copyright/permission headers.
  for (const m of text.matchAll(/(?:^[\t ]*\/\/[^\r\n]*(?:\r?\n|$))+/gm)) {
    if (/Copyright|SPDX-License-Identifier|Permission is hereby granted/i.test(m[0])) {
      blocks.push({ kind: 'source-attribution', text: m[0].trimEnd() });
    }
  }
  return blocks;
}
function flattenMap(map, visit) {
  assert.equal(map.version, 3, 'Unsupported source-map version');
  if (map.sections) {
    for (const section of map.sections) {
      assert.ok(section.map && !section.url, 'External indexed source-map sections are not permitted');
      flattenMap(section.map, visit);
    }
  } else {
    assert.ok(Array.isArray(map.sources), 'Missing source-map sources');
    map.sources.forEach((source, index) => visit(source, map.sourcesContent?.[index], map.sourceRoot || '', index));
  }
}
function upstreamProof(root, owner, wanted, contentHash, cache, preferred) {
  if (!cache.has(owner)) {
    const index = new Map();
    const packageDir = path.join(root, owner);
    for (const file of walk(packageDir, new Set(['node_modules', '.git'])).filter(f => f.endsWith('.map') && !posix(path.relative(packageDir, f)).includes('node_modules/'))) {
      const m = JSON.parse(read(root, file));
      flattenMap(m, (source, content, sourceRoot) => {
        if (typeof content !== 'string' || source.startsWith('<')) return;
        const resolved = resolveSource(file, sourceRoot, source);
        const key = `${resolved}\0${sha(content)}`;
        if (!index.has(key)) index.set(key, []);
        index.get(key).push(posix(path.relative(root, file)));
      });
    }
    cache.set(owner, index);
  }
  const matches = cache.get(owner).get(`${wanted}\0${contentHash}`) || [];
  return preferred ? matches.find(file => file === preferred) : matches[0];
}
function scan(root, cli, policy) {
  const expected = new Map(policy.packages.map(p => [p.root, p]));
  assert.equal(expected.size, policy.packages.length, 'Duplicate approved package root');
  const packages = new Map(), assets = [], records = [], cache = new Map();
  const matchedHeaders = new Set(), matchedOverrides = new Set();
  function addPackage(owner) {
    assert.ok(expected.has(owner), `Unknown/unapproved package root: ${owner}`);
    if (packages.has(owner)) return packages.get(owner);
    const approved = expected.get(owner);
    const pkg = JSON.parse(read(root, path.join(root, owner, 'package.json')));
    assert.equal(`${pkg.name}@${pkg.version}`, `${approved.name}@${approved.version}`, `Package identity/version drift: ${owner}`);
    const entry = { root: owner, name: pkg.name, version: pkg.version,
      declaredLicense: pkg.license || pkg.licenses || null, sources: [], licenseTexts: [] };
    packages.set(owner, entry); return entry;
  }
  const files = walk(path.join(cli, 'built')).filter(f => /\.(js|css|map)$/.test(f));
  for (const file of files) {
    const bytes = read(root, file), asset = posix(path.relative(cli, file));
    assets.push({ path: asset, sha256: sha(bytes), bytes: bytes.length });
    if (!file.endsWith('.map')) {
      const cssEvidence = policy.cssPackages.some(css => css.asset === asset);
      assert.ok(cssEvidence || fs.existsSync(`${file}.map`), `Missing source-map evidence: ${asset}`);
      const blocks = legalBlocks(bytes.toString('utf8'));
      for (const block of blocks) {
        const hash = sha(block.text);
        const match = policy.footers.find(x => x.asset === asset && x.sha256 === hash);
        assert.ok(match, `Unknown/changed legal footer/header: ${asset}`);
        matchedHeaders.add(`${asset}\0${hash}`);
        records.push({ kind: block.kind, asset, sha256: hash, text: block.text });
      }
      continue;
    }
    flattenMap(JSON.parse(bytes), (source, content, sourceRoot, sourceIndex) => {
      if (source === '<define:process.env>') return;
      const resolved = inside(root, resolveSource(file, sourceRoot, source));
      const physicalOwner = packageRoot(resolved);
      if (!physicalOwner) {
        assert.ok(posix(path.relative(root, resolved)).startsWith('packages/'), 'Unclassified non-package map source');
        return;
      }
      assert.equal(typeof content, 'string', `Missing third-party source content in ${asset}`);
      const hash = sha(content), sourcePath = posix(path.relative(root, resolved));
      let owner = posix(path.relative(root, physicalOwner)), proof, proofFile;
      const override = (policy.sourceOverrides || []).find(x => x.sourcePath === sourcePath);
      if (override) {
        assert.equal(hash, override.sha256, 'Source override hash drift');
        owner = override.owner;
        proofFile = upstreamProof(root, owner, resolved, hash, cache, override.upstreamMap);
        assert.equal(proofFile, override.upstreamMap, 'Source override upstream-map proof failed');
        proof = 'upstream-map'; matchedOverrides.add(sourcePath);
      } else if (fs.existsSync(resolved)) {
        assert.equal(sha(read(root, resolved)), hash, `Mapped source mismatch: ${sourcePath}`);
        proof = 'physical-source';
      } else {
        proofFile = upstreamProof(root, owner, resolved, hash, cache);
        if (proofFile) proof = 'upstream-map';
        else {
          const exception = (policy.sourceExceptions || []).find(x => x.sourcePath === sourcePath && x.sha256 === hash);
          assert.ok(exception && exception.owner === owner, `Unresolved mapped source: ${sourcePath}`);
          assert.equal(sha(read(root, path.join(root, exception.anchor))), exception.anchorSha256, 'Source exception anchor mismatch');
          proof = 'pinned-map-content-and-installed-anchor'; proofFile = exception.anchor;
        }
      }
      addPackage(owner).sources.push({ map: asset, sourceIndex, source, sourcePath, sha256: hash, proof, ...(proofFile ? { proofFile } : {}) });
    });
  }
  for (const header of policy.footers) assert.ok(matchedHeaders.has(`${header.asset}\0${header.sha256}`), `Missing legal footer/header: ${header.asset}`);
  for (const override of policy.sourceOverrides || []) assert.ok(matchedOverrides.has(override.sourcePath), 'Missing source override evidence');
  for (const css of policy.cssPackages) {
    const text = read(root, path.join(cli, css.asset)).toString('utf8');
    assert.ok(text.includes(css.banner), `Missing CSS package banner: ${css.asset}`);
    addPackage(css.root).sources.push({ asset: css.asset, proof: 'css-banner', banner: css.banner });
  }
  for (const owner of expected.keys()) assert.ok(packages.has(owner), `Missing package coverage: ${owner}`);
  return { assets, packages: [...packages.values()].sort((a, b) => a.root < b.root ? -1 : 1), records };
}
module.exports = { sha, posix, inside, read, walk, resolveSource, packageRoot, legalFooter, legalBlocks, flattenMap, scan };
