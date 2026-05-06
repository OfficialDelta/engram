import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach } from 'vitest';

let originalHome: string | undefined;
let tempHome: string;

beforeEach(() => {
  originalHome = process.env.HOME;
  tempHome = mkdtempSync(join(tmpdir(), 'engram-test-'));
  process.env.HOME = tempHome;
});

afterEach(() => {
  process.env.HOME = originalHome;
  rmSync(tempHome, { recursive: true, force: true });
});
