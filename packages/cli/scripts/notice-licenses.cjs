'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { sha, posix, read, inside } = require('./notice-evidence.cjs');
function licenseFiles(dir) {
  const result = [];
  function visit(current, legalDirectory = false) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const file = path.join(current, entry.name);
      const legalName = /^(?:licen[sc]es?|copying|copyright|notices?|authors)(?:$|[._-])/i.test(entry.name);
      if (entry.isDirectory()) visit(file, legalDirectory || legalName);
      else if ((legalName || legalDirectory) && !/\.(?:[cm]?[jt]sx?|json|map|png|jpg|svg|gif|woff2?|ttf)$/i.test(entry.name)) {
        assert.ok(entry.isFile() && !entry.isSymbolicLink(), 'Non-regular license evidence');
        result.push(file);
      }
    }
  }
  visit(dir); return result;
}
function textsFor(root, cli, policy, scan) {
  const texts = new Map(), records = [], supplements = [];
  function add(bytes) {
    assert.ok(bytes.length > 0, 'Empty license/notice text');
    const id = sha(bytes); texts.set(id, bytes); return id;
  }
  function pinned(spec) {
    assert.ok(spec.provenance && spec.sha256, 'Pinned text requires provenance and SHA-256');
    const file = inside(path.join(cli, 'third-party'), path.resolve(cli, 'third-party', spec.path));
    const bytes = read(root, file);
    assert.equal(sha(bytes), spec.sha256, `Pinned text hash mismatch: ${spec.path}`);
    return { ...spec, textId: add(bytes) };
  }
  for (const p of scan.packages) {
    const dir = path.join(root, p.root), files = licenseFiles(dir);
    const approved = policy.packages.find(x => x.root === p.root);
    if (approved.licenses) {
      const actual = files.map(f => ({ path: posix(path.relative(dir, f)), sha256: sha(read(root, f)) }));
      assert.deepEqual(actual, approved.licenses, `Installed license inventory/hash drift: ${p.root}`);
    }
    for (const f of files) {
      const bytes = read(root, f);
      p.licenseTexts.push({ path: posix(path.relative(root, f)), sha256: sha(bytes), textId: add(bytes) });
    }
    for (const override of policy.overrides || []) {
      if (override.packages.includes(`${p.name}@${p.version}`)) p.licenseTexts.push(pinned(override.text));
    }
    assert.ok(p.licenseTexts.length, `Missing license source: ${p.name}@${p.version}`);
    for (const t of p.licenseTexts) records.push({ kind: 'package-license', package: `${p.name}@${p.version}`, root: p.root, ...t });
  }
  for (const r of scan.records) {
    const { text, ...metadata } = r;
    records.push({ ...metadata, textId: add(Buffer.from(text)) });
  }
  for (const supplement of policy.supplements || []) {
    // Load texts first: corrupt pinned sources never become a passing coverage exception.
    const supplementalTexts = supplement.texts.map(pinned);
    assert.ok(supplementalTexts.length, `Missing supplemental license: ${supplement.id}`);
    for (const evidence of supplement.evidence || []) {
      const file = evidence.asset ? path.join(cli, evidence.asset) : path.join(root, evidence.source);
      const bytes = read(root, file), text = bytes.toString('utf8');
      if (evidence.sha256) assert.equal(sha(bytes), evidence.sha256, `Supplement source hash drift: ${supplement.id}`);
      for (const marker of evidence.contains || []) assert.ok(text.includes(marker), `Missing embedded header/evidence: ${supplement.id}`);
      if (evidence.source && evidence.requireMapped !== false) {
        assert.ok(scan.packages.some(p => p.sources.some(s => s.sourcePath === evidence.source)), `Supplement not mapped: ${supplement.id}`);
      }
    }
    const entry = { ...supplement, texts: supplementalTexts };
    supplements.push(entry);
    for (const t of supplementalTexts) records.push({ kind: 'supplemental-attribution', supplement: supplement.id, ...t });
  }
  return { texts, records, supplements };
}
module.exports = { licenseFiles, textsFor };
