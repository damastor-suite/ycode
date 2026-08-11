'use client';

/**
 * Live Font Updates Hook
 *
 * Listens for server-side font changes (e.g. the AI agent installing a
 * Google Font via add_font or a design-edit auto-install) and refetches the
 * font list so the builder and canvas render the new fonts without a reload.
 */

import { useEffect } from 'react';
import { createChannelLifecycle } from '@/lib/realtime-channel';
import { createRealtimeChannel } from '@/lib/realtime-client';
import { useAuthStore } from '@/stores/useAuthStore';
import { useFontsStore } from '@/stores/useFontsStore';

export function useLiveFontUpdates(): void {
  const user = useAuthStore((state) => state.user);

  useEffect(() => {
    if (!user) {
      return;
    }

    const lifecycle = createChannelLifecycle();

    const initializeChannel = async () => {
      try {
        const channel = createRealtimeChannel('fonts:updates');
        if (!lifecycle.track(channel)) return;

        channel.on('broadcast', { event: 'fonts_changed' }, () => {
          // Refetching is idempotent, so no own-broadcast filtering is needed.
          useFontsStore.getState().refreshFonts();
        });

        channel.subscribe();
      } catch (error) {
        console.error('[LIVE-FONTS] Failed to initialize:', error);
      }
    };

    initializeChannel();

    return () => {
      lifecycle.teardown();
    };
  }, [user]);
}
