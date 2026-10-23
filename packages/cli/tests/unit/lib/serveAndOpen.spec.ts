import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import serveAndOpen from '../../../src/lib/serveAndOpen';

type Served = { status?: number; contentType?: string };

// All outside paths in these regressions are disposable fixtures, never host data.

function request(url: URL): Promise<Served> {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      res.resume();
      res.on('end', () =>
        resolve({ status: res.statusCode, contentType: res.headers['content-type'] })
      );
    }).on('error', reject);
  });
}

function serve(verifyInSubdir = false): Promise<URL> {
  return new Promise((resolve) =>
    serveAndOpen('appmap.html', {}, verifyInSubdir, (url) => {
      const base = new URL(url);
      // The server listens on 127.0.0.1 only; localhost may resolve to ::1 first.
      base.hostname = '127.0.0.1';
      resolve(base);
    })
  );
}

describe('serveAndOpen', () => {
  let base: URL;
  let fixtureDir: string;

  beforeAll(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'serve-and-open-'));
    for (const name of [
      'fixture.js',
      'fixture.css',
      'fixture.json',
      'fixture.js.map',
      'fixture.bin',
    ])
      writeFileSync(join(fixtureDir, name), '{}\n');
    base = await serve();
  });

  afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

  it('serves the viewer page as text/html', async () => {
    expect(await request(new URL('/', base))).toEqual({ status: 200, contentType: 'text/html' });
  });

  it.each([
    ['/appmap.js', 'application/javascript'],
    ['/appmap.css', 'text/css'],
    ['/appmap.js.map', 'application/json'],
  ])('serves the built asset %s as %s', async (path, contentType) => {
    expect(await request(new URL(path, base))).toEqual({ status: 200, contentType });
  });

  it.each([
    ['fixture.js', 'application/javascript'],
    ['fixture.css', 'text/css'],
    ['fixture.json', 'application/json'],
    ['fixture.js.map', 'application/json'],
    ['fixture.bin', 'application/octet-stream'],
  ])('serves the resource %s as %s', async (name, contentType) => {
    const url = new URL(`/resource?${encodeURIComponent(join(fixtureDir, name))}`, base);
    expect(await request(url)).toEqual({ status: 200, contentType });
  });
});

describe('serveAndOpen canonical resource containment', () => {
  let originalCwd: string;
  let scratch: string;
  let root: string;
  let sibling: string;
  let outside: string;
  let base: URL;

  beforeAll(async () => {
    originalCwd = process.cwd();
    scratch = mkdtempSync(join(tmpdir(), 'serve-containment-'));
    root = join(scratch, 'root');
    sibling = join(scratch, 'root-neighbor');
    outside = join(scratch, 'outside');
    for (const dir of [root, sibling, outside]) mkdirSync(dir);
    writeFileSync(join(root, 'inside.json'), '{}');
    writeFileSync(join(sibling, 'outside.json'), '{"ownedSibling":true}');
    writeFileSync(join(outside, 'outside.json'), '{"ownedOutside":true}');
    symlinkSync(join(outside, 'outside.json'), join(root, 'escape.json'));
    symlinkSync(outside, join(root, 'escape-dir'), 'dir');
    symlinkSync(join(root, 'inside.json'), join(root, 'inside-link.json'));
    process.chdir(root);
    base = await serve(true);
  });

  afterAll(() => {
    if (originalCwd) process.chdir(originalCwd);
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it('Given contained files, when guarded, then preserve resource MIME and contained symlinks', async () => {
    for (const file of ['inside.json', join(root, 'inside.json'), 'inside-link.json']) {
      expect(await request(new URL(`/resource?${encodeURIComponent(file)}`, base))).toEqual({
        status: 200,
        contentType: 'application/json',
      });
    }
  });

  it.each<[string, () => string]>([
    ['prefix sibling', () => '../root-neighbor/outside.json'],
    ['absolute prefix sibling', () => join(sibling, 'outside.json')],
    ['parent traversal', () => '../outside/outside.json'],
    ['absolute outside path', () => join(outside, 'outside.json')],
    ['outside file symlink', () => 'escape.json'],
    ['outside directory symlink', () => 'escape-dir/outside.json'],
    ['missing file', () => 'missing.json'],
  ])('Given %s, when guarded, then return 404', async (_scenario, target) => {
    expect((await request(new URL(`/resource?${encodeURIComponent(target())}`, base))).status).toBe(404);
  });

  it('Given explicit false mode, when an owned outside path is requested, then preserve access', async () => {
    const unrestricted = await serve(false);
    const url = new URL(
      `/resource?${encodeURIComponent(join(outside, 'outside.json'))}`,
      unrestricted
    );
    expect((await request(url)).status).toBe(200);
  });
});
