/**
 * N→1 cutover helper: import a project dump into the shared Supabase DB
 * under a specific tenant_id, and rewrite storage paths.
 *
 * Usage (after pointing env at the SHARED project):
 *
 *   npx tsx scripts/migrate-tenant-to-shared.ts \
 *     --tenant <uuid> \
 *     --dump /path/to/export.ycode \
 *     [--dry-run]
 *
 * Prerequisites:
 * - Shared DB migrations applied (tenant_id columns + tenant_memberships)
 * - Overlay / env uses shared Supabase credentials
 * - Dump produced from the old per-site project (project export)
 *
 * Auth user remapping is intentionally manual: create users in the shared
 * Auth project, then call bootstrap_tenant_owner / createTenantMembership.
 */

import { readFileSync } from 'fs';
import { gunzipSync } from 'zlib';

import { runWithTenantId } from '../lib/supabase-server';
import {
  importProject,
  type ExportFile,
  type ProjectManifest,
} from '../lib/services/projectService';

function parseArgs(argv: string[]): {
  tenantId: string;
  dumpPath: string;
  dryRun: boolean;
} {
  let tenantId = '';
  let dumpPath = '';
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--tenant') {
      tenantId = argv[++i] || '';
    } else if (arg === '--dump') {
      dumpPath = argv[++i] || '';
    } else if (arg === '--dry-run') {
      dryRun = true;
    }
  }

  if (!tenantId || !dumpPath) {
    console.error(
      'Usage: npx tsx scripts/migrate-tenant-to-shared.ts --tenant <uuid> --dump <file> [--dry-run]'
    );
    process.exit(1);
  }

  return { tenantId, dumpPath, dryRun };
}

async function main(): Promise<void> {
  const { tenantId, dumpPath, dryRun } = parseArgs(process.argv.slice(2));

  console.log(`[migrate-tenant] tenant=${tenantId}`);
  console.log(`[migrate-tenant] dump=${dumpPath}`);
  console.log(`[migrate-tenant] dryRun=${dryRun}`);

  const raw = readFileSync(dumpPath);
  // .ycode dumps are gzip-compressed JSON in current exporter
  let jsonText: string;
  try {
    jsonText = gunzipSync(raw).toString('utf8');
  } catch {
    jsonText = raw.toString('utf8');
  }

  const parsed = JSON.parse(jsonText) as {
    manifest: ProjectManifest;
    data: Record<string, Record<string, unknown>[]>;
    files?: ExportFile[];
  };

  if (!parsed.manifest || !parsed.data) {
    throw new Error('Invalid dump: expected { manifest, data }');
  }

  console.log('[migrate-tenant] tables:', Object.keys(parsed.data).join(', '));
  console.log('[migrate-tenant] stats:', parsed.manifest.stats);

  if (dryRun) {
    console.log('[migrate-tenant] dry-run complete — no writes');
    return;
  }

  const result = await runWithTenantId(tenantId, async () =>
    importProject(parsed.manifest, parsed.data, parsed.files)
  );

  if (!result.success) {
    console.error('[migrate-tenant] import failed:', result.error);
    process.exit(1);
  }

  console.log('[migrate-tenant] import ok');
  console.log(
    '[migrate-tenant] next: remap Auth users → tenant_memberships / bootstrap_tenant_owner'
  );
  console.log(
    '[migrate-tenant] next: smoke-test site, then retire old Supabase project'
  );
}

main().catch((error) => {
  console.error('[migrate-tenant] fatal:', error);
  process.exit(1);
});
