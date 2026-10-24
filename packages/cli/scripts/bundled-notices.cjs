#!/usr/bin/env node
'use strict';
// Generated legal artifacts are deliberately exempt from source-module readability budgets.
// This offline evidence check is NOT legal clearance or proof of corresponding-source availability.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { sha, read, scan, walk, posix } = require('./notice-evidence.cjs');
const { textsFor } = require('./notice-licenses.cjs');
const DEFAULT_ROOT = path.resolve(__dirname, '../../..');
const serialize = value => `${JSON.stringify(value, null, 2)}\n`;
function calculate(root = DEFAULT_ROOT) {
  root = path.resolve(root);
  const cli = path.join(root, 'packages/cli');
  const policyBytes = read(root, path.join(cli, 'third-party/policy.json'));
  const policy = JSON.parse(policyBytes);
  assert.equal(policy.schemaVersion, 1, 'Unsupported notice policy');
  let sourceStatement;
  if (policy.sourceAvailability) {
    assert.equal(policy.sourceAvailability, 'SOURCE_AVAILABILITY.md');
    sourceStatement = read(root, path.join(cli, 'third-party', policy.sourceAvailability));
  }
  const result = scan(root, cli, policy);
  const { texts, records, supplements } = textsFor(root, cli, policy, result);
  const inventory = {
    schemaVersion: 1,
    artifactClass: 'generated-license-artifact; no source-module LOC/size budget',
    scope: 'Existing distributed JS/CSS/source maps; not all installed dependencies',
    qualification: 'Evidence coverage only; not legal clearance. Unresolved source provenance remains explicit.',
    policySha256: sha(policyBytes),
    ...(sourceStatement ? { sourceAvailability: { path: policy.sourceAvailability, sha256: sha(sourceStatement) } } : {}),
    assets: result.assets, packages: result.packages, legalRecords: records, supplements,
    gaps: policy.gaps || [],
    texts: [...texts].sort(([a], [b]) => a < b ? -1 : 1).map(([id, b]) => ({ id, path: `texts/${id}.txt`, sha256: id, bytes: b.length })),
  };
  let notices = 'THIRD-PARTY NOTICES\n\nGenerated license artifact: exempt from source-module size/LOC budgets.\n';
  notices += 'Do not edit by hand. Generated OFFLINE from distributed assets and pinned attribution evidence.\n';
  notices += 'Package metadata is not legal clearance. AppMap\'s own license does not replace third-party terms.\n';
  notices += 'The inventory records physical versions, map/header evidence, exact text sources, hashes, and limitations.\n\n';
  if (sourceStatement) notices += `${sourceStatement.toString('utf8')}\n\n`;
  notices += 'PROVENANCE QUALIFICATIONS\n';
  notices += inventory.gaps.length ? inventory.gaps.map(g => `- ${g}`).join('\n') : '- No recorded exceptions; this is not a legal assurance.';
  notices += '\n\nPACKAGE INDEX\n';
  for (const p of inventory.packages) {
    notices += `${p.name}@${p.version} (${p.root})\nDeclared license: ${JSON.stringify(p.declaredLicense)}\n`;
    for (const t of p.licenseTexts) notices += `  Text ${t.textId} — ${t.path}${t.provenance ? ` — ${t.provenance}` : ''}\n`;
  }
  notices += '\nSUPPLEMENTAL EMBEDDED MATERIAL\n';
  for (const s of supplements) {
    notices += `${s.id}: ${s.title || s.id}\nLicense: ${s.license || 'See verbatim records'}\n${s.qualification || ''}\n`;
    for (const t of s.texts) notices += `  Text ${t.textId} — ${t.provenance}\n`;
  }
  notices += '\nDISTRIBUTED LEGAL HEADERS\n';
  for (const r of records.filter(r => r.asset)) notices += `${r.asset}: ${r.kind}, text ${r.textId}\n`;
  for (const [id, bytes] of [...texts].sort(([a], [b]) => a < b ? -1 : 1)) {
    // Framing is outside the original text. UTF-8 source bytes remain untouched within delimiters.
    assert.ok(Buffer.from(bytes.toString('utf8')).equals(bytes), 'Non-UTF-8 legal text requires explicit handling');
    notices += `\n===== BEGIN VERBATIM TEXT ${id} (${bytes.length} bytes) =====\n`;
    notices += bytes.toString('utf8');
    notices += `\n===== END VERBATIM TEXT ${id} =====\n`;
  }
  return { inventory, notices, textFiles: Object.fromEntries([...texts].map(([id, bytes]) => [`texts/${id}.txt`, bytes.toString('utf8')])) };
}
function outputs(root, result) {
  const cli = path.join(root, 'packages/cli');
  return [
    [path.join(cli, 'THIRD_PARTY_NOTICES.txt'), result.notices],
    [path.join(cli, 'third-party/inventory.json'), serialize(result.inventory)],
    ...Object.entries(result.textFiles).map(([name, text]) => [path.join(cli, 'third-party', name), text]),
  ];
}
function checkFileSet(root, result) {
  const dir = path.join(root, 'packages/cli/third-party');
  const allowed = new Set(['README.md', 'policy.json', 'inventory.json', ...Object.keys(result.textFiles)]);
  if (result.inventory.sourceAvailability) allowed.add(result.inventory.sourceAvailability.path);
  for (const file of walk(dir)) {
    const relative = posix(path.relative(dir, file));
    assert.ok(allowed.has(relative), `Unexpected notice file: ${relative}`);
  }
}
function write(root, result) {
  checkFileSet(root, result);
  for (const [file, text] of outputs(root, result)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
  }
}
function check(root, result) {
  checkFileSet(root, result);
  for (const [file, text] of outputs(root, result)) {
    assert.ok(fs.existsSync(file), `Missing generated notice artifact: ${path.basename(file)}`);
    assert.ok(fs.readFileSync(file).equals(Buffer.from(text)), `Notice artifact drift: ${path.basename(file)}`);
  }
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    assert.ok(args.length === 0 || args.length === 1 && args[0] === '--check', 'Usage: node scripts/bundled-notices.cjs [--check]');
    const result = calculate();
    if (args[0] === '--check') check(DEFAULT_ROOT, result); else write(DEFAULT_ROOT, result);
    console.log(JSON.stringify({ mode: args[0] === '--check' ? 'checked' : 'generated',
      packageRoots: result.inventory.packages.length,
      packageVersions: new Set(result.inventory.packages.map(p => `${p.name}@${p.version}`)).size,
      legalRecords: result.inventory.legalRecords.length, supplementalRecords: result.inventory.supplements.length,
      unresolvedLimitations: result.inventory.gaps.length, legalClearance: false }));
  } catch (error) { console.error(`Bundled notices failed: ${error.message}`); process.exitCode = 1; }
}
module.exports = { calculate, write, check };
