/**
 * Auth Store
 *
 * Manages authentication state using Better Auth
 */

import { create } from 'zustand';
import { authClient } from '@/lib/auth-client';
import { resolveRole, type UserRole } from '@/lib/roles';

interface BetterAuthUser {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
  role?: string | null;
  emailVerified?: boolean;
  createdAt?: Date | string;
  updatedAt?: Date | string;
  created_at?: string;
  updated_at?: string;
  app_metadata?: { role?: string | null };
  user_metadata?: {
    avatar_url?: string | null;
    display_name?: string | null;
    full_name?: string | null;
  };
}

interface BetterAuthSession {
  id: string;
  token: string;
  userId: string;
  expiresAt: Date | string;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

interface BetterAuthSessionData {
  user: BetterAuthUser;
  session: BetterAuthSession;
}

type AuthResponse<T> = {
  data?: T | null;
  error?: { message?: string } | null;
};

interface AuthState {
  user: BetterAuthUser | null;
  session: BetterAuthSession | null;
  role: string | null;
  loading: boolean;
  isLoading: boolean;
  initialized: boolean;
  error: string | null;
}

interface AuthActions {
  initialize: () => Promise<void>;
  signUp: (email: string, password: string) => Promise<{ error: string | null }>;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  checkSession: () => Promise<void>;
  setError: (error: string | null) => void;
}

type AuthStore = AuthState & AuthActions;

function getErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return fallback;
}

function normalizeUser(user: BetterAuthUser | null | undefined): BetterAuthUser | null {
  if (!user) return null;

  const role = resolveRole(user.role || user.app_metadata?.role);
  return {
    ...user,
    role,
    created_at: user.created_at || new Date(user.createdAt || Date.now()).toISOString(),
    updated_at: user.updated_at || new Date(user.updatedAt || Date.now()).toISOString(),
    app_metadata: {
      ...user.app_metadata,
      role,
    },
    user_metadata: {
      avatar_url: user.user_metadata?.avatar_url || user.image || null,
      display_name: user.user_metadata?.display_name || user.name || null,
      full_name: user.user_metadata?.full_name || user.name || null,
    },
  };
}

function getRole(user: BetterAuthUser | null): UserRole | null {
  if (!user) return null;
  return resolveRole(user.role || user.app_metadata?.role);
}

async function getCurrentSession(): Promise<BetterAuthSessionData | null> {
  const response = await authClient.getSession() as AuthResponse<BetterAuthSessionData>;
  if (response.error) {
    throw new Error(response.error.message || 'Failed to get session');
  }
  if (!response.data?.user) return null;

  return {
    ...response.data,
    user: normalizeUser(response.data.user) as BetterAuthUser,
  };
}

export const useAuthStore = create<AuthStore>((set, get) => ({
  user: null,
  session: null,
  role: null,
  loading: false,
  isLoading: false,
  initialized: false,
  error: null,

  /**
   * Initialize auth state.
   * Gracefully handles missing database config (expected during setup).
   */
  initialize: async () => {
    if (get().initialized) return;

    set({ loading: true, isLoading: true, error: null });

    try {
      const data = await getCurrentSession();
      const user = data?.user ?? null;

      set({
        user,
        session: data?.session ?? null,
        role: getRole(user),
        loading: false,
        isLoading: false,
        initialized: true,
      });
    } catch (error) {
      console.error('Failed to initialize auth:', error);
      set({
        loading: false,
        isLoading: false,
        error: getErrorMessage(error, 'Failed to initialize auth'),
        initialized: true,
      });
    }
  },

  /**
   * Sign up a new user
   */
  signUp: async (email, password) => {
    set({ loading: true, isLoading: true, error: null });

    try {
      const response = await authClient.signUp.email({
        name: email.split('@')[0] || email,
        email,
        password,
        callbackURL: `${window.location.origin}/ycode`,
      }) as AuthResponse<{ user: BetterAuthUser; token?: string | null }>;

      if (response.error) {
        const message = response.error.message || 'Sign up failed';
        set({ loading: false, isLoading: false, error: message });
        return { error: message };
      }

      const session = await getCurrentSession();
      const user = session?.user ?? normalizeUser(response.data?.user);
      set({
        user,
        session: session?.session ?? null,
        role: getRole(user),
        loading: false,
        isLoading: false,
      });

      return { error: null };
    } catch (error) {
      const message = getErrorMessage(error, 'Sign up failed');
      set({ loading: false, isLoading: false, error: message });
      return { error: message };
    }
  },

  /**
   * Sign in existing user
   */
  signIn: async (email, password) => {
    set({ loading: true, isLoading: true, error: null });

    try {
      const response = await authClient.signIn.email({
        email,
        password,
      }) as AuthResponse<{ user: BetterAuthUser; token?: string | null }>;

      if (response.error) {
        const message = response.error.message || 'Sign in failed';
        set({ loading: false, isLoading: false, error: message });
        return { error: message };
      }

      const session = await getCurrentSession();
      const user = session?.user ?? normalizeUser(response.data?.user);
      set({
        user,
        session: session?.session ?? null,
        role: getRole(user),
        loading: false,
        isLoading: false,
      });

      return { error: null };
    } catch (error) {
      const message = getErrorMessage(error, 'Sign in failed');
      set({ loading: false, isLoading: false, error: message });
      return { error: message };
    }
  },

  /**
   * Sign out current user
   */
  signOut: async () => {
    set({ loading: true, isLoading: true, error: null });

    try {
      const response = await authClient.signOut() as AuthResponse<{ success: boolean }>;

      if (response.error) {
        set({ loading: false, isLoading: false, error: response.error.message || 'Sign out failed' });
        return;
      }

      set({
        user: null,
        session: null,
        role: null,
        loading: false,
        isLoading: false,
      });
    } catch (error) {
      const message = getErrorMessage(error, 'Sign out failed');
      set({ loading: false, isLoading: false, error: message });
    }
  },

  /**
   * Check current session
   */
  checkSession: async () => {
    try {
      const data = await getCurrentSession();
      const user = data?.user ?? null;
      set({
        user,
        session: data?.session ?? null,
        role: getRole(user),
      });
    } catch (error) {
      console.error('Failed to check session:', error);
    }
  },

  /**
   * Set error message
   */
  setError: (error) => {
    set({ error });
  },
}));
