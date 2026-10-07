import { describe, expect, it } from 'vitest';
import { createProgram, parsePage, parsePort } from './run.ts';

describe('parsePort', () => {
  it('accepts valid integer ports', () => {
    expect(parsePort('0')).toBe(0);
    expect(parsePort('80')).toBe(80);
    expect(parsePort('5173')).toBe(5173);
    expect(parsePort('65535')).toBe(65535);
  });

  it('rejects non-numeric input', () => {
    expect(() => parsePort('abc')).toThrow(/Invalid port/);
    expect(() => parsePort('80x')).toThrow(/Invalid port/);
  });

  it('rejects out-of-range ports', () => {
    expect(() => parsePort('-1')).toThrow(/Invalid port/);
    expect(() => parsePort('65536')).toThrow(/Invalid port/);
    expect(() => parsePort('100000')).toThrow(/Invalid port/);
  });

  it('rejects non-integer numbers', () => {
    expect(() => parsePort('80.5')).toThrow(/Invalid port/);
  });
});

describe('parsePage', () => {
  it('accepts 1-based page numbers', () => {
    expect(parsePage('1')).toBe(1);
    expect(parsePage('12')).toBe(12);
  });

  it('rejects zero, fractions, and junk', () => {
    expect(() => parsePage('0')).toThrow(/Invalid page/);
    expect(() => parsePage('1.5')).toThrow(/Invalid page/);
    expect(() => parsePage('a')).toThrow(/Invalid page/);
  });
});

describe('createProgram', () => {
  it('registers screenshot export', () => {
    const command = createProgram().commands.find((entry) => entry.name() === 'screenshot');
    expect(command?.description()).toMatch(/PNG/);
  });
});
