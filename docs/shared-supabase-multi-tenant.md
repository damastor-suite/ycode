# Shared Supabase: one project, many websites

Cloud target model: **one Supabase project** holds many websites, isolated by
`tenant_id` (row-level). Opensource stays one deploy → one database.

## Architecture

```
Proxy sets x-tenant-id
  → cloud overlay getTenantIdFromHeaders()
  → resolveTenantId() / applyTenantEq() / stampTenantId()
  → shared Postgres + assets bucket (paths under tenants/{id}/)
```

| Layer | Opensource | Cloud shared DB |
|-------|------------|-----------------|
| Credentials | Single env `SUPABASE_*` | Overlay always returns **shared** project credentials |
| Tenant id | `null` | `x-tenant-id` header + `runWithTenantId` ALS |
| Queries | No `tenant_id` filter | `.eq('tenant_id', …)` / Knex `WHERE tenant_id` |
| Storage | `website/...` | `tenants/{tenantId}/website/...` |
| Destructive ops | `TRUNCATE` whole DB | `DELETE WHERE tenant_id = ?` |
| Auth owner | First `auth.users` row | `tenant_memberships` + `bootstrap_tenant_owner()` |

## Overlay contract (Track B — cloud repo)

Override via path alias (never relative imports for these modules):

1. **`@/lib/supabase-server`**
   - `getSupabaseAdmin()` → always shared project client (ignore per-tenant URL map).
   - `getTenantIdFromHeaders()` → read `x-tenant-id`, fall back to `tenantStore`.
2. **Knex / credentials** → same shared Postgres connection string.
3. Keep proxy injecting `x-tenant-id` on every builder/site request.

**Do not flip overlay until** dual-tenant synthetic checks pass (see below).

## Control plane: stop per-site provisioning

Stop creating a Supabase project per website.

New website flow:

1. Allocate `tenant_id` (UUID).
2. Seed default settings/pages with that `tenant_id` (or apply template under `runWithTenantId`).
3. Call `bootstrap_tenant_owner(tenant_id, user_id)` for the creator.
4. Ensure storage uploads land under `tenants/{tenantId}/…`.
5. Retire per-site credential store after cutover.

## Schema helpers (this repo)

Migrations:

- `20260811000001_add_tenant_id_to_content_tables.ts` — nullable `tenant_id`,
  `set_tenant_context(uuid)`, cloud tenant-scoped unique indexes when
  `SKIP_SETUP=true`.
- `20260811000002_create_tenant_memberships.ts` — membership table +
  `bootstrap_tenant_owner(tenant_id, user_id)`.

App helpers:

- [`lib/tenant.ts`](../lib/tenant.ts) — resolve / filter / stamp / storage prefix
- [`lib/tenant-content.ts`](../lib/tenant-content.ts) — safe clear for template/import
- [`lib/repositories/tenantMembershipRepository.ts`](../lib/repositories/tenantMembershipRepository.ts)

## N→1 data migration (Track C)

Script: [`scripts/migrate-tenant-to-shared.ts`](../scripts/migrate-tenant-to-shared.ts)

Per old Supabase project:

1. Export content (project export / `.ycode` dump).
2. Import into shared DB inside `runWithTenantId(tenantId, …)` so rows stamp correctly.
3. Copy storage objects into `tenants/{tenantId}/…`; rewrite `assets.storage_path` / `public_url`.
4. Insert `tenant_memberships` for migrated Auth users (map old `auth.users` → shared Auth).
5. Smoke-test site; keep rollback = point proxy at old project credentials.
6. Decommission old Supabase project only after verify.

Batch tenants. Prefer staging shared DB first.

## Dual-tenant verify checklist

Before prod overlay flip:

- [ ] Two tenants can both have `settings.site_name` and the same page slug
- [ ] Template apply on tenant A does not delete tenant B rows
- [ ] Asset URLs for A never list under B’s library
- [ ] Background jobs using `runWithTenantId` stay scoped
- [ ] `POST /ycode/api/devtools/reset-db` returns 403 in cloud
- [ ] New cloud site creates **no** new Supabase project
- [ ] OSS wizard (no tenant header) still works on a dedicated DB

Unit coverage for helpers: `lib/tenant.test.ts`.

## RLS note

Service-role admin client bypasses RLS. Isolation depends on app-layer
`applyTenantEq` / Knex filters. Optionally add Postgres RLS using
`current_setting('app.tenant_id')` after `set_tenant_context` for defense in depth.
Anon/public reads must resolve hostname → tenant before querying published rows.
