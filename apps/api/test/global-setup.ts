import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Every test run gets its own temp root and removes it at the end: tests create repos, worktrees
 * and clones with mkdtemp and none of them cleans up, which once exhausted the inodes of /tmp.
 * The workers inherit TMPDIR, so os.tmpdir() points here for the whole run.
 */
export default function setup(): () => void {
  const root = mkdtempSync(join(tmpdir(), 'panel-run-'));
  process.env['TMPDIR'] = root;
  return () => {
    rmSync(root, { recursive: true, force: true });
  };
}
