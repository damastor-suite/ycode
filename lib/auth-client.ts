'use client';

import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({
  basePath: '/ycode/api/auth',
});

export type BetterAuthClient = typeof authClient;
