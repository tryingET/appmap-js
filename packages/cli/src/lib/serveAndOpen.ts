import { createReadStream, existsSync, realpathSync, statSync } from 'fs';
import { createServer } from 'http';
import { AddressInfo } from 'net';
import open from 'open';
import { extname, isAbsolute, join, relative, sep } from 'path';
import { parse } from 'url';
import { exists, verbose } from '../utils';
import UI from '../cmds/userInteraction';

function mimeTypeOfName(filename: string): string {
  // extname() includes the leading dot.
  return (
    {
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.map': 'application/json',
    }[extname(filename)] || 'application/octet-stream'
  );
}

export default function serveAndOpen(
  file: string,
  resources: Record<string, string>,
  verifyInSubdir: boolean,
  onListen: (url: string) => void,
  unrefOnServe = true
) {
  UI.progress(`Opening ${file}`);

  const baseDir = join(__dirname, '..', '..', 'built', 'html');
  if (!existsSync(join(baseDir, file))) throw new Error(`File ${file} does not exist`);

  const server = createServer((req, res) => {
    const send404 = () => {
      res.writeHead(404);
      res.end();
    };

    const serveStaticFile = (dir: string, fileName: string, contentType?: string) => {
      let path = isAbsolute(fileName) ? fileName : join(dir, fileName);
      if (verifyInSubdir) {
        try {
          const root = realpathSync(dir);
          path = realpathSync(path);
          const fromRoot = relative(root, path);
          if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot))
            return send404();
        } catch {
          return send404();
        }
      }
      // Canonical containment assumes a stable filesystem tree. This is not an
      // atomic open-beneath primitive: concurrent symlink/directory replacement
      // between realpath and stream open must be excluded by the caller.

      // Directories can emit stream open before EISDIR. Refuse them before
      // committing a 200 response, including explicitly unrestricted mode.
      try {
        if (!statSync(path).isFile()) return send404();
      } catch {
        return send404();
      }

      // eslint-disable-next-line no-param-reassign
      if (!contentType) contentType = mimeTypeOfName(fileName);

      const fileStream = createReadStream(path);
      const closeFile = () => {
        fileStream.destroy();
      };
      res.once('close', closeFile);
      req.once('aborted', closeFile);
      fileStream.once('close', () => {
        res.off('close', closeFile);
        req.off('aborted', closeFile);
      });
      fileStream.on('open', function () {
        // A client can disconnect while the asynchronous file open is pending.
        if (res.destroyed || req.aborted || fileStream.destroyed) return closeFile();
        if (verbose()) {
          console.log(`${path}: 200`);
        }
        res.writeHead(200, 'OK', { 'Content-Type': contentType });
      });
      fileStream.on('error', function (e) {
        if (verbose()) {
          console.log(`${path}: ${res.headersSent ? 'stream error' : '404'} (${e})`);
        }
        if (res.destroyed) return;
        // Once 200/body bytes are committed, a second status is impossible.
        // Terminate the incomplete response without killing the server.
        if (res.headersSent) res.destroy(e);
        else send404();
      });
      fileStream.pipe(res);
    };

    try {
      if (verbose()) {
        console.log(req.url);
      }

      const requestUrl = parse(req.url!);
      const pathname = requestUrl.pathname;
      if (pathname === '/') {
        return serveStaticFile(baseDir, file, 'text/html');
      } else if (pathname?.startsWith('/resource')) {
        const pathname = requestUrl.query;
        if (pathname) serveStaticFile(process.cwd(), decodeURIComponent(pathname));
        else send404();
      } else {
        serveStaticFile(baseDir, (pathname || '/').slice(1));
      }
    } catch (e) {
      if (e instanceof Error) {
        console.log(e.message);
        console.log(e.stack);
      } else {
        console.log(e);
      }
      res.writeHead(500);
      res.end(); // end the response so browsers don't hang
    }
  })
    .listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;

      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(resources)) {
        params.append(key, value);
      }
      const url = new URL(`http://localhost:${port}/?${params.toString()}`);
      onListen(url.toString());
    })
    .on('connection', function (socket) {
      // Don't let the open socket keep the process alive.
      socket.unref();
    });
  if (unrefOnServe) server.unref();
}

export async function serveAndOpenSequenceDiagram(
  diagramFile: string,
  verifyInSubdir: boolean,
  onListen: (url: string) => void
): Promise<string> {
  return new Promise((resolve) => {
    serveAndOpen(
      'sequenceDiagram.html',
      {
        diagram: ['resource', encodeURIComponent(diagramFile)].join('?'),
      },
      verifyInSubdir,
      async (url) => {
        onListen(url);
        resolve(url);
      }
    );
  });
}

export async function serveAndOpenAppMap(
  appMapFile: string,
  verifyInSubdir: boolean
): Promise<string> {
  return new Promise((resolve) => {
    serveAndOpen(
      'appmap.html',
      {
        appmap: ['resource', encodeURIComponent(appMapFile)].join('?'),
      },
      verifyInSubdir,
      async (url) => {
        await tryOpen(url);
        resolve(url);
      }
    );
  });
}

export async function serveAndOpenNavie(rpcPort: number, question?: string): Promise<string> {
  const params: Record<string, string> = {
    rpcPort: rpcPort.toString(),
  };
  if (question) params.question = question;

  return new Promise((resolve) => {
    serveAndOpen(
      'navie.html',
      params,
      false,
      async (url) => {
        await tryOpen(url);
        resolve(url);
      },
      false
    );
  });
}
async function tryOpen(url: string) {
  const showMessage = () =>
    UI.warn(`\nWe could not open the browser automatically.\nOpen ${url} to view the content.\n`);
  const cp = await open(url);
  cp.once('error', showMessage);
  cp.once('exit', (code, signal) => (code || signal) && showMessage());
}
