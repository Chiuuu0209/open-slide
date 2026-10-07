import path from 'node:path';
import * as readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { Command, Option } from 'commander';
import { assertViteResolvesToCore } from './preflight.ts';
import { detectSkillsDrift, syncSkills } from './sync.ts';
import { glyph, readVersion } from './ui.ts';

export function parsePort(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return n;
}

export function parsePage(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid page: ${value}`);
  }
  return n;
}

function collectString(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function collectPage(value: string, previous: number[] = []): number[] {
  return [...previous, parsePage(value)];
}

interface ServerFlags {
  port?: number;
  host?: string | boolean;
  open?: boolean;
}

interface DevFlags extends ServerFlags {
  skillsCheck?: boolean;
}

async function runSkillsDriftCheck(skillsDir: string): Promise<void> {
  if (process.env.OPEN_SLIDE_SKIP_SKILLS_CHECK === '1') return;

  let drift: Awaited<ReturnType<typeof detectSkillsDrift>>;
  try {
    drift = await detectSkillsDrift(skillsDir);
  } catch {
    return;
  }
  const stale = drift.filter((d) => d.status !== 'unchanged');
  if (stale.length === 0) return;

  const names = stale.map((d) => d.name).join(', ');
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const notice = `${chalk.yellow(glyph.warn)} Built-in skills are out of date: ${chalk.bold(names)}`;

  if (!interactive) {
    process.stderr.write(
      `\n  ${notice}\n    ${chalk.dim('Run `open-slide sync:skills` to update.')}\n`,
    );
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`\n  ${notice}\n    Sync now? ${chalk.dim('(Y/n)')} `))
      .trim()
      .toLowerCase();
    if (answer === '' || answer === 'y' || answer === 'yes') {
      process.stdout.write('\n');
      await syncSkills(skillsDir);
    } else {
      process.stdout.write(
        chalk.dim('    Skipped. Run `open-slide sync:skills` later to update.\n'),
      );
    }
  } finally {
    rl.close();
  }
}

interface BuildFlags {
  outDir?: string;
}

interface ScreenshotFlags {
  slide?: string[];
  page?: number[];
  out?: string;
  port?: number;
}

interface SyncFlags {
  dryRun?: boolean;
}

function resolveBuiltinSkillsDir(): string {
  // dist/cli/bin.js → ../../skills (package root + /skills)
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'skills');
}

export function createProgram(): Command {
  const program = new Command();
  program
    .name('open-slide')
    .description('Author slides in React — open-slide runs the rest.')
    .version(readVersion(), '-v, --version', 'print version')
    .helpOption('-h, --help', 'show help')
    .showHelpAfterError(chalk.dim('(run `open-slide --help` for usage)'));

  program
    .command('dev')
    .description('Start the dev server')
    .addOption(new Option('-p, --port <port>', 'port to listen on').argParser(parsePort))
    .addOption(new Option('--host [host]', 'expose on the network (optional host)'))
    .option('--open', 'open the browser on start')
    .option('--no-skills-check', 'skip the built-in skills drift check')
    .action(async (flags: DevFlags) => {
      if (flags.skillsCheck !== false) {
        await runSkillsDriftCheck(resolveBuiltinSkillsDir());
      }
      await assertViteResolvesToCore();
      const { dev } = await import('./dev.ts');
      await dev(flags);
    });

  program
    .command('build')
    .description('Build a static site')
    .option('--out-dir <dir>', 'output directory (defaults to `dist`)')
    .action(async (flags: BuildFlags) => {
      await assertViteResolvesToCore();
      const { build } = await import('./build.ts');
      await build(flags);
    });

  program
    .command('preview')
    .description('Preview the production build')
    .addOption(new Option('-p, --port <port>', 'port to listen on').argParser(parsePort))
    .addOption(new Option('--host [host]', 'expose on the network (optional host)'))
    .option('--open', 'open the browser on start')
    .action(async (flags: ServerFlags) => {
      await assertViteResolvesToCore();
      const { preview } = await import('./preview.ts');
      await preview(flags);
    });

  program
    .command('screenshot')
    .description('Export rendered slide pages as PNG files')
    .option(
      '-s, --slide <id>',
      'slide id to export (repeatable; default: every slide)',
      collectString,
    )
    .option('--page <n>', '1-based page to export (repeatable; default: every page)', collectPage)
    .option('--out <dir>', 'directory to write PNG files into', 'screenshots')
    .addOption(
      new Option('--port <port>', 'port for the temporary dev server').argParser(parsePort),
    )
    .action(async (flags: ScreenshotFlags) => {
      await assertViteResolvesToCore();
      const { screenshot } = await import('./screenshot.ts');
      await screenshot(flags);
    });

  program
    .command('sync:skills')
    .description('Sync built-in skills from @open-slide/core into this workspace')
    .option('--dry-run', 'show what would change without writing')
    .action(async (flags: SyncFlags) => {
      await syncSkills(resolveBuiltinSkillsDir(), flags);
    });

  return program;
}

export async function run(argv: string[]): Promise<void> {
  await createProgram().parseAsync(argv, { from: 'user' });
}
