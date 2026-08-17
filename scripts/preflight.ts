/**
 * Refuse to deploy a configuration that is wrong.
 *
 * `npm run doctor` talks to the database and answers "is this deployment
 * healthy". This answers a narrower question with no I/O at all: "are these
 * environment variables coherent" — which makes it safe to run as a build step,
 * in CI, or against a `.env.production.local` before anything is pushed.
 *
 * Exits non-zero on any `fail`, so wiring it into the build stops a broken
 * configuration reaching production rather than reporting it afterwards.
 */

import { config as loadEnv } from 'dotenv';

import { hasFailures, inspectEnv, type Finding } from '../src/lib/env';

const file = process.argv.find((arg) => arg.startsWith('--env='))?.slice(6);
loadEnv(file ? { path: file } : { path: '.env.local' });
loadEnv();

const MARK: Record<Finding['level'], string> = {
  fail: '[31m  FAIL[0m',
  warn: '[33m  WARN[0m',
  ok: '[32m  ok  [0m'
};

function main(): void {
  const findings = inspectEnv(process.env);

  console.log('\nDEPLOYMENT PREFLIGHT');
  console.log('─'.repeat(72));

  for (const finding of findings) {
    console.log(`${MARK[finding.level]} ${finding.area.padEnd(12)} ${finding.detail}`);
    if (finding.fix && finding.level !== 'ok') {
      console.log(`${' '.repeat(8)}${' '.repeat(12)} → ${finding.fix}`);
    }
  }

  const failures = findings.filter((finding) => finding.level === 'fail').length;
  const warnings = findings.filter((finding) => finding.level === 'warn').length;

  console.log('─'.repeat(72));

  if (hasFailures(findings)) {
    console.log(
      `\n${failures} problem${failures === 1 ? '' : 's'} that will break production. Not safe to deploy.\n`
    );
    process.exit(1);
  }

  console.log(
    warnings > 0
      ? `\nNo blocking problems. ${warnings} thing${warnings === 1 ? '' : 's'} worth knowing about.\n`
      : '\nConfiguration is coherent.\n'
  );
}

main();
