import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  getTenantStoragePrefix,
  resolveTenantId,
  stampTenantId,
  stampTenantIdMany,
} from '@/lib/tenant';
import { runWithTenantId } from '@/lib/tenant-context';

describe('tenant helpers', () => {
  it('resolveTenantId prefers explicit id', async () => {
    const id = await resolveTenantId('11111111-1111-1111-1111-111111111111');
    assert.equal(id, '11111111-1111-1111-1111-111111111111');
  });

  it('resolveTenantId reads runWithTenantId store', async () => {
    const tenantA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const resolved = await runWithTenantId(tenantA, () => resolveTenantId());
    assert.equal(resolved, tenantA);
  });

  it('stampTenantId no-ops without tenant', async () => {
    const row = await stampTenantId({ key: 'site_name', value: 'A' });
    assert.deepEqual(row, { key: 'site_name', value: 'A' });
  });

  it('stampTenantId adds tenant_id from explicit arg', async () => {
    const tenantA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const row = await stampTenantId({ key: 'site_name', value: 'A' }, tenantA);
    assert.equal(row.tenant_id, tenantA);
    assert.equal(row.key, 'site_name');
  });

  it('stampTenantIdMany isolates two tenants', async () => {
    const tenantA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const tenantB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

    const rowsA = await stampTenantIdMany(
      [{ key: 'site_name', value: 'Site A' }],
      tenantA
    );
    const rowsB = await stampTenantIdMany(
      [{ key: 'site_name', value: 'Site B' }],
      tenantB
    );

    assert.equal(rowsA[0].tenant_id, tenantA);
    assert.equal(rowsB[0].tenant_id, tenantB);
    assert.notEqual(rowsA[0].tenant_id, rowsB[0].tenant_id);
  });

  it('getTenantStoragePrefix prefixes shared-bucket paths', () => {
    assert.equal(getTenantStoragePrefix(null), '');
    assert.equal(
      getTenantStoragePrefix('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
      'tenants/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/'
    );
  });
});
