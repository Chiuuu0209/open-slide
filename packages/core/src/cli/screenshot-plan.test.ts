import { describe, expect, it } from 'vitest';
import { FrameParser } from './cdp.ts';
import {
  type ChromeLookup,
  findChromeBinary,
  missingBrowserMessage,
  planScreenshots,
  screenshotFilename,
} from './screenshot-plan.ts';

const slides = [
  { id: 'intro', pages: 3 },
  { id: 'notes', pages: 1 },
];

function lookup(over: Partial<ChromeLookup> = {}): ChromeLookup {
  return {
    env: {},
    platform: 'linux',
    isExecutable: () => false,
    listDir: () => [],
    ...over,
  };
}

describe('planScreenshots', () => {
  it('exports every page of every slide by default', () => {
    expect(planScreenshots(slides, { slideIds: [], pages: [] })).toEqual([
      { slideId: 'intro', page: 1 },
      { slideId: 'intro', page: 2 },
      { slideId: 'intro', page: 3 },
      { slideId: 'notes', page: 1 },
    ]);
  });

  it('limits to the requested slide and pages', () => {
    expect(planScreenshots(slides, { slideIds: ['notes'], pages: [1] })).toEqual([
      { slideId: 'notes', page: 1 },
    ]);
  });

  it('rejects an unknown slide and an out-of-range page', () => {
    expect(() => planScreenshots(slides, { slideIds: ['missing'], pages: [] })).toThrow(
      /Slide not found: missing/,
    );
    expect(() => planScreenshots(slides, { slideIds: ['notes'], pages: [2] })).toThrow(
      /--page 2 is out of range/,
    );
  });

  it('rejects an empty deck', () => {
    expect(() => planScreenshots([], { slideIds: [], pages: [] })).toThrow(/No slides found/);
  });
});

describe('screenshotFilename', () => {
  it('pads the page number', () => {
    expect(screenshotFilename('ssh-explained', 1)).toBe('ssh-explained-p01.png');
    expect(screenshotFilename('ssh-explained', 12)).toBe('ssh-explained-p12.png');
  });
});

describe('findChromeBinary', () => {
  it('fails with an install hint when nothing is installed', () => {
    expect(() => findChromeBinary(lookup())).toThrow(missingBrowserMessage());
    expect(missingBrowserMessage()).toContain('npx playwright install chromium');
    expect(missingBrowserMessage()).toContain('OPEN_SLIDE_CHROME');
  });

  it('reports a bad OPEN_SLIDE_CHROME path without a stack', () => {
    expect(() =>
      findChromeBinary(lookup({ env: { OPEN_SLIDE_CHROME: '/missing/chrome' } })),
    ).toThrow(/OPEN_SLIDE_CHROME points at \/missing\/chrome/);
  });

  it('uses an explicit executable, then PATH, then the Playwright cache', () => {
    expect(
      findChromeBinary(
        lookup({
          env: { OPEN_SLIDE_CHROME: '/opt/chrome' },
          isExecutable: (file) => file === '/opt/chrome',
        }),
      ),
    ).toBe('/opt/chrome');

    expect(
      findChromeBinary(
        lookup({
          env: { PATH: '/usr/local/bin' },
          isExecutable: (file) => file === '/usr/local/bin/google-chrome',
        }),
      ),
    ).toBe('/usr/local/bin/google-chrome');

    expect(
      findChromeBinary(
        lookup({
          env: { HOME: '/home/agent' },
          listDir: () => ['chromium-1200'],
          isExecutable: (file) => file.endsWith('/chrome-linux64/chrome'),
        }),
      ),
    ).toBe('/home/agent/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome');
  });
});

describe('FrameParser', () => {
  it('decodes a short text frame split across chunks', () => {
    const parser = new FrameParser();
    const frame = Buffer.from([0x81, 0x02, 0x68, 0x69]);
    expect(parser.push(frame.subarray(0, 1))).toEqual([]);
    expect(parser.push(frame.subarray(1))).toEqual([{ opcode: 0x1, data: Buffer.from('hi') }]);
  });

  it('decodes a 16-bit length frame and a fragmented message', () => {
    const payload = Buffer.from('x'.repeat(200));
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    const parser = new FrameParser();
    expect(parser.push(Buffer.concat([header, payload]))).toEqual([{ opcode: 0x1, data: payload }]);

    const fragmented = new FrameParser();
    const first = Buffer.from([0x01, 0x01, 0x61]);
    const second = Buffer.from([0x80, 0x01, 0x62]);
    expect(fragmented.push(first)).toEqual([]);
    expect(fragmented.push(second)).toEqual([{ opcode: 0x1, data: Buffer.from('ab') }]);
  });
});
