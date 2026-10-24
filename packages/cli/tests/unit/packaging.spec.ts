import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const packageRoot = resolve(__dirname, '../..');

describe('compiled-assets-only CLI packaging', () => {
  it('keeps publication safety and bundled notice contracts executable in CI', () => {
    execFileSync(
      process.execPath,
      [
        '--test',
        resolve(__dirname, '../publication-safety.test.cjs'),
        resolve(__dirname, '../bundled-notices.test.cjs'),
      ],
      {
        cwd: packageRoot,
        encoding: 'utf8',
        timeout: 90000,
        maxBuffer: 4 * 1024 * 1024,
      }
    );
  }, 100000);

  it('Given compiled viewer assets, when declaring the package, then do not promise bundled package folders', () => {
    const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
      bundledDependencies?: string[];
      bundleDependencies?: string[];
      dependencies: Record<string, string>;
    };
    expect(manifest.bundledDependencies).toBeUndefined();
    expect(manifest.bundleDependencies).toBeUndefined();
    expect(manifest.dependencies['@appland/components']).toBeDefined();
    expect(manifest.dependencies['@appland/diagrams']).toBeDefined();
  });

  it('Given existing built assets, when actually packed offline, then the archive satisfies the manifest and byte contract', () => {
    // The standalone runner uses built assets from this checkout by default.
    // APPMAP_PACK_ASSETS is an explicit reconstructed-pack option, never build proof.
    expect(() =>
      execFileSync(process.execPath, ['--test', resolve(__dirname, '../packaging.test.cjs')], {
        cwd: packageRoot,
        encoding: 'utf8',
        timeout: 90000,
        maxBuffer: 4 * 1024 * 1024,
      })
    ).not.toThrow();
  }, 100000);
});
