import { accessSync, constants, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CANVAS_WIDTH = 1920;
export const CANVAS_HEIGHT = 1080;

export type SlideInfo = { id: string; pages: number };
export type Shot = { slideId: string; page: number };

const CHROME_NAMES = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'chrome',
];

export function screenshotFilename(slideId: string, page: number): string {
  return `${slideId}-p${String(page).padStart(2, '0')}.png`;
}

export function planScreenshots(
  slides: SlideInfo[],
  opts: { slideIds: string[]; pages: number[] },
): Shot[] {
  const byId = new Map(slides.map((slide) => [slide.id, slide]));
  const slideIds =
    opts.slideIds.length > 0 ? unique(opts.slideIds) : slides.map((slide) => slide.id);
  if (slideIds.length === 0) {
    throw new Error('No slides found. Add a deck under slides/<id>/index.tsx.');
  }
  const pages = unique(opts.pages);
  const shots: Shot[] = [];
  for (const id of slideIds) {
    const slide = byId.get(id);
    if (!slide) throw new Error(`Slide not found: ${id}`);
    if (slide.pages < 1) throw new Error(`Slide ${id} has no pages.`);
    const selected = pages.length > 0 ? pages : range(slide.pages);
    for (const page of selected) {
      if (!Number.isInteger(page) || page < 1 || page > slide.pages) {
        const noun = slide.pages === 1 ? 'page' : 'pages';
        throw new Error(`Slide ${id} has ${slide.pages} ${noun}; --page ${page} is out of range.`);
      }
      shots.push({ slideId: id, page });
    }
  }
  return shots;
}

export function missingBrowserMessage(): string {
  return [
    'Screenshot export needs Chrome or Chromium, and no browser binary was found.',
    '',
    'Install one, then re-run the command:',
    '  macOS:          brew install --cask google-chrome',
    '  Debian/Ubuntu:  sudo apt install chromium',
    '  Any OS:         npx playwright install chromium',
    '',
    'Or set OPEN_SLIDE_CHROME to the browser executable.',
  ].join('\n');
}

export type ChromeLookup = {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  isExecutable: (file: string) => boolean;
  listDir: (dir: string) => string[];
};

export function findChromeBinary(lookup: ChromeLookup = defaultChromeLookup()): string {
  const explicit = lookup.env.OPEN_SLIDE_CHROME?.trim();
  if (explicit) {
    if (!lookup.isExecutable(explicit)) {
      throw new Error(
        `OPEN_SLIDE_CHROME points at ${explicit}, which is not an executable.\n\n${missingBrowserMessage()}`,
      );
    }
    return explicit;
  }
  for (const candidate of defaultCandidates(lookup.platform, lookup.env)) {
    if (lookup.isExecutable(candidate)) return candidate;
  }
  const pathEnv = lookup.env.PATH ?? '';
  const names =
    lookup.platform === 'win32' ? CHROME_NAMES.map((name) => `${name}.exe`) : CHROME_NAMES;
  for (const name of names) {
    for (const dir of pathEnv.split(path.delimiter)) {
      if (!dir) continue;
      const file = path.join(dir, name);
      if (lookup.isExecutable(file)) return file;
    }
  }
  const cached = playwrightChrome(lookup);
  if (cached) return cached;
  throw new Error(missingBrowserMessage());
}

function defaultChromeLookup(): ChromeLookup {
  return {
    env: process.env,
    platform: process.platform,
    isExecutable(file) {
      try {
        accessSync(file, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    listDir(dir) {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    },
  };
}

function defaultCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(
      (root): root is string => Boolean(root),
    );
    return roots.map((root) => path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];
}

function playwrightChrome(lookup: ChromeLookup): string | null {
  const home = lookup.env.HOME || lookup.env.USERPROFILE || os.homedir();
  const root = path.join(home, '.cache', 'ms-playwright');
  const dirs = lookup
    .listDir(root)
    .filter((name) => name.startsWith('chromium-'))
    .sort();
  const suffixes = [
    ['chrome-linux64', 'chrome'],
    ['chrome-linux', 'chrome'],
    [
      'chrome-mac-arm64',
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing',
    ],
    ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
    ['chrome-win64', 'chrome.exe'],
    ['chrome-win', 'chrome.exe'],
  ];
  for (let i = dirs.length - 1; i >= 0; i--) {
    const dir = dirs[i];
    if (!dir) continue;
    for (const parts of suffixes) {
      const file = path.join(root, dir, ...parts);
      if (lookup.isExecutable(file)) return file;
    }
  }
  return null;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function range(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index + 1);
}
