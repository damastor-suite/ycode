/**
 * Auth port — Better Auth session helpers for server routes / proxy.
 */

import type { AuthUser } from '@/types';

export type AppRole = 'owner' | 'admin' | 'designer' | 'editor';

export interface SessionUser extends AuthUser {
  role?: AppRole | string | null;
  name?: string | null;
  image?: string | null;
  emailVerified?: boolean;
  createdAt?: Date | string;
  updatedAt?: Date | string;
  app_metadata?: { role?: AppRole | string | null };
  user_metadata?: {
    avatar_url?: string | null;
    display_name?: string | null;
    full_name?: string | null;
  };
}

export interface AuthSession {
  user: SessionUser;
  session: {
    id: string;
    expiresAt: Date;
    token: string;
  };
}

/**
 * Get the current authenticated session (server).
 * Returns null when unauthenticated or auth not configured.
 */
export async function getServerSession(): Promise<AuthSession | null> {
  try {
    const { auth } = await import('@/lib/auth');
    const { headers } = await import('next/headers');
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session?.user) return null;

    const user = session.user as SessionUser;
    const createdAt = user.createdAt || user.created_at || new Date().toISOString();
    const updatedAt = user.updatedAt || user.updated_at || new Date().toISOString();
    const role = (user.role as AppRole) || 'editor';

    return {
      user: {
        id: user.id,
        email: user.email,
        created_at: new Date(createdAt).toISOString(),
        updated_at: new Date(updatedAt).toISOString(),
        role,
        name: user.name,
        image: user.image,
        emailVerified: user.emailVerified,
        app_metadata: { role },
        user_metadata: {
          avatar_url: user.image || null,
          display_name: user.name || null,
          full_name: user.name || null,
        },
      },
      session: {
        id: session.session.id,
        expiresAt: new Date(session.session.expiresAt),
        token: session.session.token,
      },
    };
  } catch {
    return null;
  }
}

/**
 * Compatibility helper formerly backed by Supabase Auth.
 */
export async function getAuthUser(): Promise<{ user: SessionUser } | null> {
  const session = await getServerSession();
  if (!session) return null;
  return { user: session.user };
}
