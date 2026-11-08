import type { Config } from '../config';
import { pactumAdapter } from './pactum';
import { playwrightAdapter } from './playwright';
import type { FrameworkAdapter, FrameworkName } from './types';

export const FRAMEWORKS: Record<FrameworkName, FrameworkAdapter> = { playwright: playwrightAdapter, pactum: pactumAdapter };

// The input file's "framework" field decides; missing means playwright.
export function frameworkFor(config: Config): FrameworkAdapter {
  return FRAMEWORKS[config.framework ?? 'playwright'];
}

export type { FrameworkAdapter, FrameworkName, RunResult, TestOutcome, FrameworkInfo } from './types';
