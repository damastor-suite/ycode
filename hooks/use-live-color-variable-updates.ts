'use client';

/**
 * Live Color Variable Updates Hook
 *
 * Listens for server-side color variable changes (e.g. the AI agent creating
 * design tokens via create_color_variable) and refetches the variable list.
 * The canvas resolves var(--<id>) references from CSS generated out of the
 * client store (see Canvas.tsx / generateCssDeclarations), so without this
 * signal agent-created variables render as nothing until a full page reload.
 */

import { useEffect } from 'react';
import { createChannelLifecycle } from '@/lib/realtime-channel';
import { createRealtimeChannel } from '@/lib/realtime-client';
import { useAuthStore } from '@/stores/useAuthStore';
import { useColorVariablesStore } from '@/stores/useColorVariablesStore';

export function useLiveColorVariableUpdates(): void {
  const user = useAuthStore((state) => state.user);

  useEffect(() => {
    if (!user) {
      return;
    }

    const lifecycle = createChannelLifecycle();

    const initializeChannel = async () => {
      try {
        const channel = createRealtimeChannel('color-variables:updates');
        if (!lifecycle.track(channel)) return;

        channel.on('broadcast', { event: 'color_variables_changed' }, () => {
          // Refetching is idempotent, so no own-broadcast filtering is needed.
          useColorVariablesStore.getState().loadColorVariables();
        });

        channel.subscribe();
      } catch (error) {
        console.error('[LIVE-COLOR-VARIABLES] Failed to initialize:', error);
      }
    };

    initializeChannel();

    return () => {
      lifecycle.teardown();
    };
  }, [user]);
}
