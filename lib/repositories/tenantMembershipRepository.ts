/**
 * Tenant membership repository
 *
 * Maps auth users to websites in a shared Supabase project.
 */

import { getSupabaseAdmin } from '@/lib/supabase-server';
import { applyTenantEq, stampTenantId } from '@/lib/tenant';

export type TenantRole = 'owner' | 'designer' | 'viewer';

export interface TenantMembership {
  id: string;
  tenant_id: string;
  user_id: string;
  role: TenantRole;
  created_at: string;
  updated_at: string;
}

export interface CreateTenantMembershipData {
  tenant_id: string;
  user_id: string;
  role?: TenantRole;
}

/**
 * List memberships for the active (or explicit) tenant.
 */
export async function getTenantMemberships(
  tenantId?: string
): Promise<TenantMembership[]> {
  const client = await getSupabaseAdmin(tenantId);
  if (!client) {
    throw new Error('Supabase not configured');
  }

  let query = client.from('tenant_memberships').select('*');
  query = (await applyTenantEq(query, tenantId)).query;

  const { data, error } = await query.order('created_at', { ascending: true });
  if (error) {
    throw new Error(`Failed to fetch tenant memberships: ${error.message}`);
  }

  return (data || []) as TenantMembership[];
}

/**
 * Get a user's membership for a tenant.
 */
export async function getTenantMembership(
  userId: string,
  tenantId?: string
): Promise<TenantMembership | null> {
  const client = await getSupabaseAdmin(tenantId);
  if (!client) {
    throw new Error('Supabase not configured');
  }

  let query = client
    .from('tenant_memberships')
    .select('*')
    .eq('user_id', userId);
  query = (await applyTenantEq(query, tenantId)).query;

  const { data, error } = await query.maybeSingle();
  if (error) {
    throw new Error(`Failed to fetch tenant membership: ${error.message}`);
  }

  return data as TenantMembership | null;
}

/**
 * Add a member. Prefer bootstrap_tenant_owner() SQL for first owner.
 */
export async function createTenantMembership(
  membership: CreateTenantMembershipData
): Promise<TenantMembership> {
  const client = await getSupabaseAdmin(membership.tenant_id);
  if (!client) {
    throw new Error('Supabase not configured');
  }

  const payload = await stampTenantId(
    {
      tenant_id: membership.tenant_id,
      user_id: membership.user_id,
      role: membership.role || 'designer',
      updated_at: new Date().toISOString(),
    },
    membership.tenant_id
  );

  const { data, error } = await client
    .from('tenant_memberships')
    .upsert(payload, { onConflict: 'tenant_id,user_id' })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create tenant membership: ${error.message}`);
  }

  return data as TenantMembership;
}

/**
 * Bootstrap first owner for a tenant via DB function (idempotent).
 */
export async function bootstrapTenantOwner(
  tenantId: string,
  userId: string
): Promise<void> {
  const client = await getSupabaseAdmin(tenantId);
  if (!client) {
    throw new Error('Supabase not configured');
  }

  const { error } = await client.rpc('bootstrap_tenant_owner', {
    p_tenant_id: tenantId,
    p_user_id: userId,
  });

  if (error) {
    throw new Error(`Failed to bootstrap tenant owner: ${error.message}`);
  }
}
