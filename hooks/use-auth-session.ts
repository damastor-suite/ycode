'use client';

/**
 * Hook to check the current Better Auth session.
 * Gracefully returns null if the database is not configured.
 */

import { useEffect, useState } from 'react';
import { authClient } from '@/lib/auth-client';

interface AuthSession {
  id: string;
  token: string;
  userId: string;
  expiresAt: Date | string;
}

interface AuthSessionResponse {
  data?: {
    session: AuthSession;
  } | null;
  error?: { message?: string } | null;
}

interface AuthSessionState {
  session: AuthSession | null;
  isLoading: boolean;
}

export function useAuthSession(): AuthSessionState {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const checkSession = async () => {
      try {
        const response = await authClient.getSession() as AuthSessionResponse;
        setSession(response.data?.session ?? null);
      } catch {
        // Auth database not available — treated as no session
      } finally {
        setIsLoading(false);
      }
    };
    checkSession();
  }, []);

  return { session, isLoading };
}
