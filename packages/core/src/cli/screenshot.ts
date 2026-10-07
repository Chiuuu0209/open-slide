import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createServer, mergeConfig, type ViteDevServer } from 'vite';
import { createViteConfig } from '../vite/config.ts';
import { CdpConnection, connectWebSocket } from './cdp.ts';
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  findChromeBinary,
  planScreenshots,
  type SlideInfo,
  screenshotFilename,
} from './screenshot-plan.ts';
import { createCliLogger } from './ui.ts';

export interface ScreenshotOptions {
  slide?: string[];
  page?: number[];
  out?: string;
  port?: number;
}

const FIRST_LOAD_TIMEOUT_MS = 90_000;
const CANVAS_TIMEOUT_MS = 45_000;

export async function screenshot(opts: ScreenshotOptions = {}): Promise<void> {
  const chrome = findChromeBinary();
  const slideIds = opts.slide ?? [];
  const pages = opts.page ?? [];
  const outDir = path.resolve(process.cwd(), opts.out ?? 'screenshots');
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'open-slide-chrome-'));
  let server: ViteDevServer | undefined;
  let launched: LaunchedChrome | undefined;
  let cdp: CdpConnection | undefined;
  try {
    server = await startServer(opts.port);
    const origin = serverOrigin(server);
    const base = server.config.base || '/';
    launched = launchChrome(chrome, userDataDir);
    const wsUrl = await waitForDebugger(launched, userDataDir);
    cdp = new CdpConnection(await connectWebSocket(wsUrl));
    const sessionId = await openSession(cdp);
    await prepareSession(cdp, sessionId);
    await navigate(cdp, sessionId, new URL(joinBase(base, ''), origin).href, FIRST_LOAD_TIMEOUT_MS);
    const slides = await listSlides(
      cdp,
      sessionId,
      joinBase(base, '@id/__x00__virtual:open-slide/slides'),
      slideIds,
    );
    const shots = planScreenshots(slides, { slideIds, pages });
    await mkdir(outDir, { recursive: true });
    const noun = shots.length === 1 ? 'page' : 'pages';
    process.stdout.write(`  exporting ${shots.length} ${noun} to ${displayPath(outDir)}\n`);
    let lastSlide: string | null = null;
    for (const shot of shots) {
      const url = slidePageUrl(origin, base, shot.slideId, shot.page);
      if (lastSlide !== shot.slideId) {
        await navigate(cdp, sessionId, url, FIRST_LOAD_TIMEOUT_MS);
        lastSlide = shot.slideId;
      } else {
        await goToPage(cdp, sessionId, shot.page);
      }
      await waitForCanvas(cdp, sessionId, shot.page - 1, url);
      const file = path.join(outDir, screenshotFilename(shot.slideId, shot.page));
      await captureCanvas(cdp, sessionId, file);
      process.stdout.write(`  wrote ${displayPath(file)}\n`);
    }
  } finally {
    cdp?.close();
    killChrome(launched?.child);
    await server?.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
}

async function startServer(port: number | undefined): Promise<ViteDevServer> {
  const base = await createViteConfig({ userCwd: process.cwd() });
  const server = await createServer(
    mergeConfig(base, {
      logLevel: 'error',
      customLogger: createCliLogger(),
      server: {
        host: '127.0.0.1',
        port: port ?? 0,
        strictPort: port !== undefined,
      },
    }),
  );
  await server.listen();
  return server;
}

function serverOrigin(server: ViteDevServer): string {
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') {
    throw new Error('Dev server did not listen on a TCP port.');
  }
  return `http://127.0.0.1:${address.port}`;
}

type LaunchedChrome = { child: ChildProcess; stderr: () => string };

function launchChrome(binary: string, userDataDir: string): LaunchedChrome {
  // Container kernels often reject Chrome's sandbox helper. The process only
  // opens the local preview, then exits.
  const child = spawn(
    binary,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { detached: true, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-8_000);
  });
  child.on('error', () => {});
  return { child, stderr: () => stderr };
}

async function waitForDebugger(launched: LaunchedChrome, userDataDir: string): Promise<string> {
  const file = path.join(userDataDir, 'DevToolsActivePort');
  const started = Date.now();
  let spawnError: Error | undefined;
  launched.child.on('error', (error) => {
    spawnError = error;
  });
  while (Date.now() - started < 20_000) {
    if (spawnError) throw new Error(`Failed to launch Chrome.\n${spawnError.message}`);
    if (launched.child.exitCode != null) {
      throw new Error(chromeExitMessage(launched.stderr()));
    }
    try {
      const text = await readFile(file, 'utf8');
      const port = Number(text.split('\n')[0]);
      if (Number.isInteger(port) && port > 0) {
        const version = (await getJson(`http://127.0.0.1:${port}/json/version`)) as {
          webSocketDebuggerUrl?: string;
        };
        if (version.webSocketDebuggerUrl) return version.webSocketDebuggerUrl;
      }
    } catch {}
    await delay(50);
  }
  throw new Error(
    `Timed out waiting for Chrome's debugging port.\n${launched.stderr().trim()}`.trim(),
  );
}

function chromeExitMessage(stderr: string): string {
  const tail = stderr.trim();
  return tail
    ? `Chrome exited before the debugging port was ready.\n${tail}`
    : 'Chrome exited before the debugging port was ready.';
}

function killChrome(child: ChildProcess | undefined): void {
  if (!child?.pid || child.exitCode != null) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

async function openSession(cdp: CdpConnection): Promise<string> {
  const created = (await cdp.send('Target.createTarget', { url: 'about:blank' })) as {
    targetId: string;
  };
  const attached = (await cdp.send('Target.attachToTarget', {
    targetId: created.targetId,
    flatten: true,
  })) as { sessionId: string };
  return attached.sessionId;
}

async function prepareSession(cdp: CdpConnection, sessionId: string): Promise<void> {
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send(
    'Emulation.setDeviceMetricsOverride',
    { width: CANVAS_WIDTH, height: CANVAS_HEIGHT, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );
  await cdp.send(
    'Emulation.setEmulatedMedia',
    { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] },
    sessionId,
  );
}

async function navigate(
  cdp: CdpConnection,
  sessionId: string,
  url: string,
  timeoutMs: number,
): Promise<void> {
  await cdp.send('Page.navigate', { url }, sessionId);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const href = await evaluate<string>(cdp, sessionId, 'location.href');
      const ready = await evaluate<boolean>(cdp, sessionId, 'document.readyState === "complete"');
      if (ready && sameUrl(href, url)) return;
    } catch {
      // The page context is destroyed while the navigation commits.
    }
    await delay(100);
  }
  throw new Error(`Timed out loading ${url}`);
}

function sameUrl(actual: string, expected: string): boolean {
  try {
    const left = new URL(actual);
    const right = new URL(expected);
    return (
      left.origin === right.origin &&
      left.pathname === right.pathname &&
      left.search === right.search
    );
  } catch {
    return false;
  }
}

async function listSlides(
  cdp: CdpConnection,
  sessionId: string,
  modulePath: string,
  slideIds: string[],
): Promise<SlideInfo[]> {
  const expression = `(async () => {
    const mod = await import(${JSON.stringify(modulePath)});
    const known = new Set(mod.slideIds);
    const wanted = ${JSON.stringify(slideIds)};
    const missing = wanted.filter((id) => !known.has(id));
    if (missing.length > 0) return { error: 'Slide not found: ' + missing[0] };
    const ids = wanted.length > 0 ? wanted : mod.slideIds;
    const slides = [];
    for (const id of ids) {
      const slide = await mod.loadSlide(id);
      slides.push({ id, pages: Array.isArray(slide.default) ? slide.default.length : 0 });
    }
    return { slides };
  })()`;
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const result = await evaluate<{ slides?: SlideInfo[]; error?: string }>(
        cdp,
        sessionId,
        expression,
      );
      if (result.error) throw new Error(result.error);
      return result.slides ?? [];
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (lastError.message.startsWith('Slide not found:')) throw lastError;
      await delay(500);
    }
  }
  throw lastError ?? new Error('Could not read the slide list from the dev server.');
}

async function goToPage(cdp: CdpConnection, sessionId: string, page: number): Promise<void> {
  // A full reload would warm the deck again. pushState + popstate is what
  // react-router listens for, and `?p=` stays on the page the URL names.
  await evaluate(
    cdp,
    sessionId,
    `(() => {
      const url = new URL(location.href);
      url.searchParams.set('p', ${JSON.stringify(String(page))});
      history.pushState(history.state, '', url);
      window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
      return true;
    })()`,
  );
}

async function waitForCanvas(
  cdp: CdpConnection,
  sessionId: string,
  pageIndex: number,
  url: string,
): Promise<void> {
  const started = Date.now();
  const probe = `(() => {
    const canvas = document.querySelector('main[data-inspector-root] [data-osd-canvas]');
    if (!(canvas instanceof HTMLElement)) return false;
    const current = canvas.querySelector('[data-osd-current-page]');
    if (!current || current.getAttribute('data-osd-current-page') !== ${JSON.stringify(String(pageIndex))}) return false;
    const pending = [...canvas.querySelectorAll('img')].some((img) => !img.complete);
    if (pending) return false;
    return !document.fonts || document.fonts.status === 'loaded';
  })()`;
  while (Date.now() - started < CANVAS_TIMEOUT_MS) {
    let ready = false;
    try {
      ready = await evaluate<boolean>(cdp, sessionId, probe);
    } catch {
      ready = false;
    }
    if (ready) {
      await evaluate(
        cdp,
        sessionId,
        `(async () => {
          if (document.fonts?.ready) {
            await Promise.race([
              document.fonts.ready,
              new Promise((resolve) => setTimeout(resolve, 8000)),
            ]);
          }
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        })()`,
      );
      return;
    }
    await delay(100);
  }
  let detail = '';
  try {
    detail = await evaluate<string>(
      cdp,
      sessionId,
      'document.body?.innerText?.slice(0, 400) ?? ""',
    );
  } catch {}
  throw new Error(
    [`Timed out waiting for the slide canvas at ${url}.`, detail.trim()].filter(Boolean).join('\n'),
  );
}

async function captureCanvas(cdp: CdpConnection, sessionId: string, file: string): Promise<void> {
  // Ancestor transforms make position:fixed relative to the scaled frame, so
  // the canvas would screenshot at thumbnail size. Clear those, then pin the
  // 1920×1080 canvas to the viewport.
  const rect = await evaluate<{ x: number; y: number; width: number; height: number } | null>(
    cdp,
    sessionId,
    `(() => {
      const canvas = document.querySelector('main[data-inspector-root] [data-osd-canvas]');
      if (!(canvas instanceof HTMLElement)) return null;
      let node = canvas.parentElement;
      while (node && node !== document.documentElement) {
        node.style.setProperty('transform', 'none', 'important');
        node.style.setProperty('overflow', 'visible', 'important');
        node.style.setProperty('filter', 'none', 'important');
        node.style.setProperty('perspective', 'none', 'important');
        node.style.setProperty('contain', 'none', 'important');
        node = node.parentElement;
      }
      document.documentElement.style.overflow = 'hidden';
      document.body.style.overflow = 'hidden';
      document.body.style.margin = '0';
      canvas.style.setProperty('transform', 'none', 'important');
      canvas.style.setProperty('position', 'fixed', 'important');
      canvas.style.setProperty('left', '0', 'important');
      canvas.style.setProperty('top', '0', 'important');
      canvas.style.setProperty('margin', '0', 'important');
      canvas.style.setProperty('width', '${CANVAS_WIDTH}px', 'important');
      canvas.style.setProperty('height', '${CANVAS_HEIGHT}px', 'important');
      canvas.style.setProperty('z-index', '2147483647', 'important');
      const box = canvas.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    })()`,
  );
  if (!rect) throw new Error('Slide canvas disappeared before the screenshot.');
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  if (Math.abs(width - CANVAS_WIDTH) > 2 || Math.abs(height - CANVAS_HEIGHT) > 2) {
    throw new Error(
      `Slide canvas measured ${width}×${height}, expected ${CANVAS_WIDTH}×${CANVAS_HEIGHT}.`,
    );
  }
  const shot = (await cdp.send(
    'Page.captureScreenshot',
    {
      format: 'png',
      captureBeyondViewport: true,
      clip: {
        x: Math.max(0, Math.round(rect.x)),
        y: Math.max(0, Math.round(rect.y)),
        width: CANVAS_WIDTH,
        height: CANVAS_HEIGHT,
        scale: 1,
      },
    },
    sessionId,
    30_000,
  )) as { data?: string };
  if (!shot.data) throw new Error('Chrome returned an empty screenshot.');
  await writeFile(file, Buffer.from(shot.data, 'base64'));
}

type EvalBody = {
  result?: { value?: unknown };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
};

async function evaluate<T>(cdp: CdpConnection, sessionId: string, expression: string): Promise<T> {
  const body = (await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
    20_000,
  )) as EvalBody;
  if (body.exceptionDetails) {
    throw new Error(
      body.exceptionDetails.exception?.description ??
        body.exceptionDetails.text ??
        'Page script failed',
    );
  }
  return body.result?.value as T;
}

function displayPath(file: string): string {
  const relative = path.relative(process.cwd(), file);
  if (!relative || relative.startsWith('..')) return file;
  return relative;
}

function slidePageUrl(origin: string, base: string, slideId: string, page: number): string {
  const url = new URL(joinBase(base, `s/${encodeURIComponent(slideId)}`), origin);
  url.searchParams.set('p', String(page));
  return url.href;
}

function joinBase(base: string, rel: string): string {
  const prefix = base.endsWith('/') ? base.slice(0, -1) : base;
  if (!rel) return `${prefix}/`;
  return `${prefix}/${rel}`;
}

function getJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.setTimeout(1000, () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', reject);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
