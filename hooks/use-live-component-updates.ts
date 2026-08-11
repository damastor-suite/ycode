'use client';

/**
 * Live Component Updates Hook
 * 
 * Manages real-time synchronization of component changes.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useAuthStore } from '../stores/useAuthStore';
import { useComponentsStore } from '../stores/useComponentsStore';
import { useCollaborationPresenceStore } from '../stores/useCollaborationPresenceStore';
import { usePagesStore } from '../stores/usePagesStore';
import { createChannelLifecycle } from '@/lib/realtime-channel';
import { createRealtimeChannel } from '@/lib/realtime-client';
import type { YcodeRealtimeChannel } from '@/lib/realtime-client';
import type { Component, Layer } from '../types';

// Types for component updates
interface ComponentUpdate {
  component_id: string;
  user_id: string;
  changes: Partial<Component>;
  timestamp: number;
}

export interface UseLiveComponentUpdatesReturn {
  broadcastComponentCreate: (component: Component) => void;
  broadcastComponentUpdate: (componentId: string, changes: Partial<Component>) => void;
  broadcastComponentDelete: (componentId: string) => void;
  broadcastComponentLayersUpdate: (componentId: string, layers: Layer[]) => void;
  isConnected: boolean;
}

export function useLiveComponentUpdates(): UseLiveComponentUpdatesReturn {
  const user = useAuthStore((state) => state.user);
  const updateUser = useCollaborationPresenceStore((state) => state.updateUser);
  const currentUserId = useCollaborationPresenceStore((state) => state.currentUserId);
  
  const channelRef = useRef<YcodeRealtimeChannel | null>(null);
  const isConnectedRef = useRef(false);
  
  // Initialize realtime channel for component updates
  useEffect(() => {
    if (!user) {
      return;
    }
    
    const lifecycle = createChannelLifecycle();

    const initializeChannel = async () => {
      try {
        const channel = createRealtimeChannel('components:updates');
        if (!lifecycle.track(channel)) return;

        channel.on('broadcast', { event: 'component_created' }, (payload) => {
          handleIncomingComponentCreate(payload.payload as { component: Component; user_id: string });
        });

        channel.on('broadcast', { event: 'component_updated' }, (payload) => {
          handleIncomingComponentUpdate(payload.payload as ComponentUpdate);
        });

        channel.on('broadcast', { event: 'component_deleted' }, (payload) => {
          handleIncomingComponentDelete(payload.payload as { component_id: string; user_id: string });
        });

        channel.on('broadcast', { event: 'component_layers_updated' }, (payload) => {
          handleIncomingComponentLayersUpdate(payload.payload as {
            component_id: string;
            layers: Layer[];
            user_id: string;
          });
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
        console.error('[LIVE-COMPONENT] Failed to initialize:', error);
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
  
  const handleIncomingComponentCreate = useCallback((payload: { component: Component; user_id: string }) => {
    const freshCurrentUserId = useCollaborationPresenceStore.getState().currentUserId;
    
    // Ignore own broadcasts
    if (!freshCurrentUserId || payload.user_id === freshCurrentUserId) {
      return;
    }
    
    // Add the component to the store
    const { components } = useComponentsStore.getState();
    
    // Check if already exists (avoid duplicates)
    if (components.some(c => c.id === payload.component.id)) {
      return;
    }
    
    useComponentsStore.setState(state => ({
      components: [payload.component, ...state.components],
    }));
  }, []);
  
  const handleIncomingComponentUpdate = useCallback((payload: ComponentUpdate) => {
    const freshCurrentUserId = useCollaborationPresenceStore.getState().currentUserId;
    
    if (!freshCurrentUserId || payload.user_id === freshCurrentUserId) {
      return;
    }
    
    // Update the component in the store
    useComponentsStore.setState(state => ({
      components: state.components.map(c => 
        c.id === payload.component_id 
          ? { ...c, ...payload.changes }
          : c
      ),
    }));
  }, []);
  
  const handleIncomingComponentDelete = useCallback((payload: { component_id: string; user_id: string }) => {
    const freshCurrentUserId = useCollaborationPresenceStore.getState().currentUserId;
    
    if (!freshCurrentUserId || payload.user_id === freshCurrentUserId) {
      return;
    }
    
    // Remove the component from the store
    useComponentsStore.setState(state => ({
      components: state.components.filter(c => c.id !== payload.component_id),
    }));
  }, []);
  
  const handleIncomingComponentLayersUpdate = useCallback((payload: { 
    component_id: string; 
    layers: Layer[]; 
    user_id: string 
  }) => {
    const freshCurrentUserId = useCollaborationPresenceStore.getState().currentUserId;
    
    if (!freshCurrentUserId || payload.user_id === freshCurrentUserId) {
      return;
    }
    
    // Update the component's layers in the store
    useComponentsStore.setState(state => ({
      components: state.components.map(c => 
        c.id === payload.component_id 
          ? { ...c, layers: payload.layers }
          : c
      ),
    }));
    
    // Also update all instances of this component across all pages
    const { updateComponentOnLayers } = usePagesStore.getState();
    updateComponentOnLayers(payload.component_id);
  }, []);
  
  // === BROADCAST FUNCTIONS ===
  
  const broadcastComponentCreate = useCallback((component: Component) => {
    if (!channelRef.current || !currentUserId) {
      console.warn('[LIVE-COMPONENT] Cannot broadcast - channel not ready');
      return;
    }
    
    channelRef.current.send({
      type: 'broadcast',
      event: 'component_created',
      payload: {
        component,
        user_id: currentUserId,
        timestamp: Date.now(),
      },
    });
    
    updateUser(currentUserId, { last_active: Date.now() });
  }, [currentUserId, updateUser]);
  
  const broadcastComponentUpdate = useCallback((componentId: string, changes: Partial<Component>) => {
    if (!channelRef.current || !currentUserId) {
      return;
    }
    
    channelRef.current.send({
      type: 'broadcast',
      event: 'component_updated',
      payload: {
        component_id: componentId,
        changes,
        user_id: currentUserId,
        timestamp: Date.now(),
      },
    });
    
    updateUser(currentUserId, { last_active: Date.now() });
  }, [currentUserId, updateUser]);
  
  const broadcastComponentDelete = useCallback((componentId: string) => {
    if (!channelRef.current || !currentUserId) {
      return;
    }
    
    channelRef.current.send({
      type: 'broadcast',
      event: 'component_deleted',
      payload: {
        component_id: componentId,
        user_id: currentUserId,
        timestamp: Date.now(),
      },
    });
    
    updateUser(currentUserId, { last_active: Date.now() });
  }, [currentUserId, updateUser]);
  
  const broadcastComponentLayersUpdate = useCallback((componentId: string, layers: Layer[]) => {
    if (!channelRef.current || !currentUserId) {
      return;
    }
    
    channelRef.current.send({
      type: 'broadcast',
      event: 'component_layers_updated',
      payload: {
        component_id: componentId,
        layers,
        user_id: currentUserId,
        timestamp: Date.now(),
      },
    });
    
    updateUser(currentUserId, { last_active: Date.now() });
  }, [currentUserId, updateUser]);
  
  // Stable return reference: broadcast callbacks are already memoized via
  // useCallback. `isConnected` is a ref that mutates silently — no consumer
  // reads it. Stabilizing avoids cascading re-renders downstream.
  return useMemo(() => ({
    broadcastComponentCreate,
    broadcastComponentUpdate,
    broadcastComponentDelete,
    broadcastComponentLayersUpdate,
    isConnected: isConnectedRef.current,
  }), [broadcastComponentCreate, broadcastComponentUpdate, broadcastComponentDelete, broadcastComponentLayersUpdate]);
}
