# Bundled attribution evidence

`THIRD_PARTY_NOTICES.txt`, `inventory.json`, `policy.json`, and `texts/*.txt` are
**generated license/evidence artifacts**, not code modules or narrative docs.
Their complete legal texts and provenance lists intentionally exceed normal
source-module file-size/line budgets. Do not truncate legal texts to fit those
budgets. Generator modules and tests remain within their respective budgets.

From `packages/cli`:

```sh
node scripts/bundled-notices.cjs          # Generate from existing built assets; offline
node scripts/bundled-notices.cjs --check  # Recompute; fail on missing/corrupt/drifting artifacts
```

From the repository root:

```sh
node --test packages/cli/tests/bundled-notices.test.cjs
```

No command installs dependencies, fetches network resources, rebuilds bundles,
or packs/publishes the application. Generation requires the physical source
installation and existing `built` JS/CSS/maps. The result is not proof of a fresh
build or legal clearance.

## Coverage and adoption

The initial evidence set contains 168 physical package roots, 166 distinct
package/version pairs, seven distributed legal blocks, and fourteen supplemental
records. Source maps establish membership; the entire installation is NOT used
as a dependency inventory. Missing original TypeScript sources resolve through
installed upstream maps. The Lucide `shared/src/utils.ts` exception requires
matching content and the explicitly identified Lucide upstream map. Nineteen
missing `diff/src/*` sources use pinned content plus an independently mapped
installed `diff/lib/index.mjs` anchor; that qualification remains in the result.

`policy.json` is the explicit, versioned evidence-adoption surface. It pins
physical package identities, installed legal-file hashes, distributed legal
blocks, missing-license source texts, source exceptions, and supplements.
Dependency/version/header changes fail closed until their new evidence is
inspected and the policy is deliberately updated. Do not regenerate this policy
blindly to make a failing check pass. `inventory.json` is a derived projection.

Each content-addressed text file is copied verbatim. The notice renders each
unique text once, outside framing delimiters; package/header/supplement records
retain their associations. `--check` verifies every required text file as well
as the rendered notice and inventory. Local paths in provenance are relative to
the source installation; upstream records retain URLs, SHA-256, and archive
members/ranges where applicable. Timestamps and machine-specific absolute paths
are excluded from generated outputs.

## Supplemental sources and limitations

Mermaid and seventeen Micromark packages omit standalone license files in this
installation. Their full MIT texts are pinned from publication-linked upstream
commits. Micromark READMEs identify the repository-root license; version-specific
registry metadata links all seventeen to the same commit, even though auxiliary
repository manifests contain earlier version numbers. Embedded js-yaml is 4.1.0,
not the installed root package's version.

Supplements preserve ELK/web-worker, Cytoscape vendor credits, KaTeX's legacy
React/Apache attribution, Pako's Zlib notices, and decamelize-derived CLI code.
ELK dependency archive headers are a **conservative attribution superset**, not
an assertion that every source member was emitted. EMF-GWT 2.12.4 is EPL-1.0;
ELK and Xbase/Xtend are EPL-2.0. GWT/Guava headers identify Apache-2.0; exact
verbatim archive headers and full standard license terms are retained.

ELK's external source checkout and historical resolved build inputs are not
pinned by the elkjs release metadata. `SOURCE_AVAILABILITY.md` supplies recipient
retrieval instructions under the applicable EPL versions, including actual ELK
Java sources. Historical version mapping and complete opaque-prebundle provenance
remain qualified in the inventory and rendered notice. A successful check establishes
the recorded coverage/byte contract, **not fulfillment of every license obligation**.

## Publication integration

The CLI build generates notices offline after compiling assets and synchronizing
docs. The npm allowlist and native asset list include `THIRD_PARTY_NOTICES.txt`
and `third-party`; actual-pack tests check their bytes. Unknown surplus files in
`third-party` fail both generation and checking. Scoped Git attributes preserve
verbatim legal bytes across autocrlf checkouts. Publication remains a separate act.
