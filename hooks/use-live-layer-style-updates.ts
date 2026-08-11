'use client';

/**
 * Live Layer Style Updates Hook
 *
 * Manages real-time synchronization of layer style changes.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useAuthStore } from '../stores/useAuthStore';
import { useLayerStylesStore } from '../stores/useLayerStylesStore';
import { useCollaborationPresenceStore } from '../stores/useCollaborationPresenceStore';
import { detachStyleAcrossStores, updateStyleAcrossStores } from '../lib/layer-style-store-utils';
import { createChannelLifecycle } from '@/lib/realtime-channel';
import { createRealtimeChannel } from '@/lib/realtime-client';
import type { YcodeRealtimeChannel } from '@/lib/realtime-client';
import type { LayerStyle } from '../types';

// Types for style updates
interface StyleUpdate {
  style_id: string;
  user_id: string;
  changes: Partial<LayerStyle>;
  timestamp: number;
}

export interface UseLiveLayerStyleUpdatesReturn {
  broadcastStyleCreate: (style: LayerStyle) => void;
  broadcastStyleUpdate: (styleId: string, changes: Partial<LayerStyle>) => void;
  broadcastStyleDelete: (styleId: string) => void;
  isConnected: boolean;
}

export function useLiveLayerStyleUpdates(): UseLiveLayerStyleUpdatesReturn {
  const user = useAuthStore((state) => state.user);
  const updateUser = useCollaborationPresenceStore((state) => state.updateUser);
  const currentUserId = useCollaborationPresenceStore((state) => state.currentUserId);

  const channelRef = useRef<YcodeRealtimeChannel | null>(null);
  const isConnectedRef = useRef(false);

  // Initialize realtime channel for style updates
  useEffect(() => {
    if (!user) {
      return;
    }

    const lifecycle = createChannelLifecycle();

    const initializeChannel = async () => {
      try {
        const channel = createRealtimeChannel('layer-styles:updates');
        if (!lifecycle.track(channel)) return;

        channel.on('broadcast', { event: 'style_created' }, (payload) => {
          handleIncomingStyleCreate(payload.payload as { style: LayerStyle; user_id: string });
        });

        channel.on('broadcast', { event: 'style_updated' }, (payload) => {
          handleIncomingStyleUpdate(payload.payload as StyleUpdate);
        });

        channel.on('broadcast', { event: 'style_deleted' }, (payload) => {
          handleIncomingStyleDelete(payload.payload as { style_id: string; user_id: string });
        });

        channel.subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            isConnectedRef.current = true;
          } else {
            isConnectedRef.current = false;
          }
        });

        if (lifecycle.cancelled) return;
        channelRef.current = channel;
      } catch (error) {
        console.error('[LIVE-STYLE] Failed to initialize:', error);
      }
    };

    initializeChannel();

    return () => {
      lifecycle.teardown();
      channelRef.current = null;
      isConnectedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // === INCOMING HANDLERS ===

  const handleIncomingStyleCreate = useCallback((payload: { style: LayerStyle; user_id: string }) => {
    const freshCurrentUserId = useCollaborationPresenceStore.getState().currentUserId;

    // Ignore own broadcasts
    if (!freshCurrentUserId || payload.user_id === freshCurrentUserId) {
      return;
    }

    // Add the style to the store
    const { styles } = useLayerStylesStore.getState();

    // Check if already exists (avoid duplicates)
    if (styles.some(s => s.id === payload.style.id)) {
      return;
    }

    useLayerStylesStore.setState(state => ({
      styles: [payload.style, ...state.styles],
    }));
  }, []);

  const handleIncomingStyleUpdate = useCallback((payload: StyleUpdate) => {
    const freshCurrentUserId = useCollaborationPresenceStore.getState().currentUserId;

    if (!freshCurrentUserId || payload.user_id === freshCurrentUserId) {
      return;
    }

    // Update the style in the store
    useLayerStylesStore.setState(state => ({
      styles: state.styles.map(s =>
        s.id === payload.style_id
          ? { ...s, ...payload.changes }
          : s
      ),
    }));

    // If the style has classes or design changes, update layers using this style
    if (payload.changes.classes !== undefined || payload.changes.design !== undefined) {
      const updatedStyle = useLayerStylesStore.getState().styles.find(s => s.id === payload.style_id);
      if (updatedStyle) {
        updateStyleAcrossStores(
          payload.style_id,
          updatedStyle.classes,
          updatedStyle.design
        );
      }
    }
  }, []);

  const handleIncomingStyleDelete = useCallback((payload: { style_id: string; user_id: string }) => {
    const freshCurrentUserId = useCollaborationPresenceStore.getState().currentUserId;

    if (!freshCurrentUserId || payload.user_id === freshCurrentUserId) {
      return;
    }

    // Remove the style from the store
    useLayerStylesStore.setState(state => ({
      styles: state.styles.filter(s => s.id !== payload.style_id),
    }));

    // Detach style from all layers (pages and components)
    detachStyleAcrossStores(payload.style_id);
  }, []);

  // === BROADCAST FUNCTIONS ===

  const broadcastStyleCreate = useCallback((style: LayerStyle) => {
    if (!channelRef.current || !currentUserId) {
      console.warn('[LIVE-STYLE] Cannot broadcast - channel not ready');
      return;
    }

    channelRef.current.send({
      type: 'broadcast',
      event: 'style_created',
      payload: {
        style,
        user_id: currentUserId,
        timestamp: Date.now(),
      },
    });

    updateUser(currentUserId, { last_active: Date.now() });
  }, [currentUserId, updateUser]);

  const broadcastStyleUpdate = useCallback((styleId: string, changes: Partial<LayerStyle>) => {
    if (!channelRef.current || !currentUserId) {
      return;
    }

    channelRef.current.send({
      type: 'broadcast',
      event: 'style_updated',
      payload: {
        style_id: styleId,
        changes,
        user_id: currentUserId,
        timestamp: Date.now(),
      },
    });

    updateUser(currentUserId, { last_active: Date.now() });
  }, [currentUserId, updateUser]);

  const broadcastStyleDelete = useCallback((styleId: string) => {
    if (!channelRef.current || !currentUserId) {
      return;
    }

    channelRef.current.send({
      type: 'broadcast',
      event: 'style_deleted',
      payload: {
        style_id: styleId,
        user_id: currentUserId,
        timestamp: Date.now(),
      },
    });

    updateUser(currentUserId, { last_active: Date.now() });
  }, [currentUserId, updateUser]);

  return {
    broadcastStyleCreate,
    broadcastStyleUpdate,
    broadcastStyleDelete,
    isConnected: isConnectedRef.current,
  };
}
