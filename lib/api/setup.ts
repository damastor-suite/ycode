/**
 * Setup API Client
 *
 * Handles communication with Next.js setup API routes
 */

import type { ApiResponse, DatabaseConfig } from '@/types';

/**
 * Check if setup is complete
 */
export async function checkSetupStatus(): Promise<{
  is_configured: boolean;
  is_setup_complete: boolean;
  is_vercel: boolean;
  error?: string;
}> {
  const response = await fetch('/ycode/api/setup/status');

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Connect database credentials.
 */
export async function connectDatabase(
  config: DatabaseConfig
): Promise<ApiResponse<void>> {
  const response = await fetch('/ycode/api/setup/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      databaseUrl: config.databaseUrl,
      ...(config.authSecret ? { authSecret: config.authSecret } : {}),
    }),
  });

  return response.json();
}

/** @deprecated Use connectDatabase. */
export const connectSupabase = connectDatabase;

/**
 * Run database migrations (checks and runs if needed)
 */
export async function runMigrations(): Promise<ApiResponse<void>> {
  const response = await fetch('/ycode/api/setup/migrate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });

  return response.json();
}

/**
 * Better Auth does not require a Supabase email confirmation setting.
 */
export async function checkEmailConfirmDisabled(): Promise<{
  autoconfirm: boolean;
  error?: string;
}> {
  const response = await fetch('/ycode/api/setup/check-email-confirm');
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.error || `HTTP ${response.status}: ${response.statusText}`);
  }

  return data;
}

/**
 * Complete setup (no-op now, kept for compatibility)
 */
export async function completeSetup(): Promise<ApiResponse<{ redirect_url: string }>> {
  return {
    data: {
      redirect_url: '/ycode',
    },
  };
}
