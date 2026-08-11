import { useCallback, useEffect, useRef, useState } from 'react'
import { useCollaborationPresenceStore } from '../stores/useCollaborationPresenceStore'
import { useAuthStore } from '../stores/useAuthStore'
import { useEditorStore } from '../stores/useEditorStore'
import { createChannelLifecycle } from '@/lib/realtime-channel'
import { createRealtimeChannel } from '@/lib/realtime-client'
import type { YcodeRealtimeChannel } from '@/lib/realtime-client'

/**
 * Throttle a callback to a certain delay, It will only call the callback if the delay has passed, with the arguments
 * from the last call
 */
const useThrottleCallback = <Params extends unknown[], Return>(
  callback: (...args: Params) => Return,
  delay: number
) => {
  const lastCall = useRef(0)
  const timeout = useRef<NodeJS.Timeout | null>(null)

  return useCallback(
    (...args: Params) => {
      const now = Date.now()
      const remainingTime = delay - (now - lastCall.current)

      if (remainingTime <= 0) {
        if (timeout.current) {
          clearTimeout(timeout.current)
          timeout.current = null
        }
        lastCall.current = now
        callback(...args)
      } else if (!timeout.current) {
        timeout.current = setTimeout(() => {
          lastCall.current = Date.now()
          timeout.current = null
          callback(...args)
        }, remainingTime)
      }
    },
    [callback, delay]
  )
}

// Curated collaboration colors that match the project's design system
const COLLABORATION_COLORS = [
  '#8b5cf6', // violet-500 (matches component purple)
  '#3b82f6', // blue-500 (matches primary/selection)
  '#14b8a6', // teal-500 (matches interactions)
  '#10b981', // emerald-500 (fresh green)
  '#f59e0b', // amber-500 (warm accent)
  '#ec4899', // pink-500 (vibrant contrast)
  '#06b6d4', // cyan-500 (cool blue)
  '#6366f1', // indigo-500 (deep purple-blue)
];

const generateRandomColor = () => COLLABORATION_COLORS[Math.floor(Math.random() * COLLABORATION_COLORS.length)]

// Use a more stable user ID based on email or user ID
const generateUserId = (username: string) => {
  return username.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0)
}

const EVENT_NAME = 'realtime-cursor-move'
const PRESENCE_SYNC_EVENT = 'presence_sync'
const PRESENCE_JOIN_EVENT = 'presence_join'
const PRESENCE_LEAVE_EVENT = 'presence_leave'

// How often we refresh a remote user's metadata in the local store while
// receiving their cursor broadcasts. Anything more frequent than this just
// produces re-render churn for subscribers of `users` without visible benefit.
const REMOTE_USER_REFRESH_MS = 5000

type CursorEventPayload = {
    position: {
        x: number
        y: number
    }
    user: {
        id: number
        name: string
        authId?: string // Actual auth user ID for lock comparison
        avatarUrl?: string | null
    }
    color: string
    timestamp: number
    selectedLayerId?: string | null
    isEditing?: boolean
    lockedLayerId?: string | null
}

type PresenceEventPayload = {
    key: number
    authId?: string
    email?: string
    name: string
    color: string
    avatarUrl?: string | null
    lockedLayerId?: string | null
    timestamp: number
}

export const useRealtimeCursors = ({
  roomName,
  username,
  throttleMs,
}: {
    roomName: string
    username: string
    throttleMs: number
}) => {
  const [color] = useState(generateRandomColor())
  const [userId] = useState(generateUserId(username))
  const [cursors, setCursors] = useState<Record<string, CursorEventPayload>>({})
  const cursorPayload = useRef<CursorEventPayload | null>(null)
  const remoteUserLastRefresh = useRef<Record<string, number>>({})

  const channelRef = useRef<YcodeRealtimeChannel | null>(null)
    
  // Get collaboration state
  const setConnectionStatus = useCollaborationPresenceStore((s) => s.setConnectionStatus);
  const setCurrentUser = useCollaborationPresenceStore((s) => s.setCurrentUser);
  const user = useAuthStore((s) => s.user);
  const selectedLayerId = useEditorStore((s) => s.selectedLayerId);
  const selectedLayerIdRef = useRef(selectedLayerId)
  selectedLayerIdRef.current = selectedLayerId
  
  // Ref to avoid stale closures and prevent channel reinitialization on user object reference changes
  const userRef = useRef(user)
  userRef.current = user
  const hasUser = !!user

  const createPresencePayload = useCallback((): PresenceEventPayload => {
    const currentUser = userRef.current

    return {
      key: userId,
      authId: currentUser?.id,
      email: currentUser?.email || username,
      name: username,
      color,
      avatarUrl: currentUser?.user_metadata?.avatar_url || null,
      lockedLayerId: selectedLayerIdRef.current || null,
      timestamp: Date.now(),
    }
  }, [color, userId, username])

  const syncRemotePresence = useCallback((presence: PresenceEventPayload) => {
    const { updateUser: storeUpdateUser } = useCollaborationPresenceStore.getState()
    const currentAuthId = userRef.current?.id
    const remoteAuthId = presence.authId

    if (!remoteAuthId || remoteAuthId === currentAuthId) {
      return
    }

    storeUpdateUser(remoteAuthId, {
      user_id: remoteAuthId,
      email: presence.email || presence.name || 'Unknown',
      color: presence.color || '#3b82f6',
      avatar_url: presence.avatarUrl || null,
      selected_layer_id: presence.lockedLayerId || null,
      last_active: Date.now()
    })
  }, [])

  const callback = useCallback(
    (event: MouseEvent) => {
      const { clientX, clientY } = event

      const payload: CursorEventPayload = {
        position: {
          x: clientX,
          y: clientY,
        },
        user: {
          id: userId,
          name: username,
          authId: user?.id, // Include actual auth ID for lock comparison
          avatarUrl: user?.user_metadata?.avatar_url || null,
        },
        color: color,
        timestamp: new Date().getTime(),
        selectedLayerId: selectedLayerId,
        isEditing: false, // This would be set based on actual editing state
        lockedLayerId: selectedLayerId || null,
      }

      cursorPayload.current = payload

      // Only broadcast cursor position to other users here.
      // We intentionally do NOT call updateUser() for the local user on every
      // mousemove: that would spread the entire `users` slice in the
      // collaboration store every ~30ms, forcing all subscribers (toolbar,
      // panels, popovers) to re-render and starving the browser of paint time
      // — which causes CSS :hover to lag during quick cursor sweeps.
      // Local user metadata is initialized in the subscribe handler and
      // `selected_layer_id` / `last_active` are kept fresh via separate effects.
      channelRef.current?.send({
        type: 'broadcast',
        event: EVENT_NAME,
        payload: payload,
      })
    },
    [color, userId, username, selectedLayerId, user]
  )

  const handleMouseMove = useThrottleCallback(callback, throttleMs)

  // Clear cursors when room changes
  useEffect(() => {
    setCursors({});
  }, [roomName]);

  // Cleanup stale cursors - remove if not updated in 3 seconds
  useEffect(() => {
    const STALE_THRESHOLD_MS = 3000;
    
    const interval = setInterval(() => {
      const now = Date.now();
      setCursors((prev) => {
        const updated = { ...prev };
        let changed = false;
        
        Object.keys(updated).forEach((key) => {
          if (now - updated[key].timestamp > STALE_THRESHOLD_MS) {
            delete updated[key];
            changed = true;
          }
        });
        
        return changed ? updated : prev;
      });
    }, 1000);
    
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const lifecycle = createChannelLifecycle();

    const initializeChannel = async () => {
      const channel = createRealtimeChannel(roomName)
      if (!lifecycle.track(channel)) return;

      channel
        .on('broadcast', { event: PRESENCE_SYNC_EVENT }, (data) => {
          const payload = data.payload as PresenceEventPayload
          syncRemotePresence(payload)
        })
        .on('broadcast', { event: PRESENCE_LEAVE_EVENT }, (data) => {
          const payload = data.payload as PresenceEventPayload
          const { removeUser } = useCollaborationPresenceStore.getState();
          const currentAuthId = userRef.current?.id;

          setCursors((prev) => {
            if (!prev[payload.key]) {
              return prev
            }

            const updated = { ...prev }
            delete updated[payload.key]
            return updated
          })

          // Remove user from collaboration store (locks are handled by use-layer-locks.ts)
          // Don't remove the current user - they might just be reconnecting.
          if (payload.authId && payload.authId !== currentAuthId) {
            removeUser(payload.authId);
          }
        })
        .on('broadcast', { event: PRESENCE_JOIN_EVENT }, (data) => {
          const payload = data.payload as PresenceEventPayload
          syncRemotePresence(payload)

          if (payload.authId === userRef.current?.id) return

          // All cursors broadcast their position when a new cursor joins.
          if (cursorPayload.current) {
            channelRef.current?.send({
              type: 'broadcast',
              event: EVENT_NAME,
              payload: cursorPayload.current,
            })
          }

          channelRef.current?.send({
            type: 'broadcast',
            event: PRESENCE_SYNC_EVENT,
            payload: createPresencePayload(),
          })
        })
        .on('broadcast', { event: EVENT_NAME }, (data) => {
          const payload = data.payload as CursorEventPayload
          const { user: remoteUser, lockedLayerId, color: remoteColor } = payload
          // Don't render your own cursor
          if (remoteUser.id === userId) return

          // Update collaboration store with remote user info for lock indicator display
          // (Locks are handled by use-layer-locks.ts, not here)
          // Throttle to once every REMOTE_USER_REFRESH_MS per user — otherwise every
          // incoming cursor broadcast (~33/sec per user) spreads the `users` slice
          // and re-renders every subscriber, starving CSS :hover paints.
          if (remoteUser.authId) {
            const now = Date.now();
            const lastRefreshed = remoteUserLastRefresh.current[remoteUser.authId] ?? 0;
            if (now - lastRefreshed >= REMOTE_USER_REFRESH_MS) {
              remoteUserLastRefresh.current[remoteUser.authId] = now;
              const { updateUser: storeUpdateUser } = useCollaborationPresenceStore.getState();
              storeUpdateUser(remoteUser.authId, {
                user_id: remoteUser.authId,
                email: remoteUser.name,
                color: remoteColor,
                avatar_url: remoteUser.avatarUrl || null,
                last_active: now
              });
            }
          }

          setCursors((prev) => {
            if (prev[userId]) {
              delete prev[userId]
            }

            return {
              ...prev,
              [remoteUser.id]: payload,
            }
          })
        })
        .subscribe((status: string) => {
          if (status === 'SUBSCRIBED') {
            if (lifecycle.cancelled) return;
            const currentUser = userRef.current;
            const avatarUrl = currentUser?.user_metadata?.avatar_url || null;
            channelRef.current = channel
            setConnectionStatus(true)

            channel.send({
              type: 'broadcast',
              event: PRESENCE_JOIN_EVENT,
              payload: createPresencePayload(),
            })
                    
            // Set current user in collaboration store
            if (currentUser && currentUser.email) {
              const avatarUrl = currentUser.user_metadata?.avatar_url || null;
              const displayName = currentUser.user_metadata?.display_name || '';
              setCurrentUser(currentUser.id, currentUser.email, avatarUrl)
              // Also add current user to users object with email, display name, and avatar
              const { updateUser: storeUpdateUser } = useCollaborationPresenceStore.getState();
              storeUpdateUser(currentUser.id, {
                user_id: currentUser.id,
                email: currentUser.email,
                display_name: displayName,
                avatar_url: avatarUrl,
                color: color,
                last_active: Date.now()
              })
            }
          } else {
            setCursors({})
            channelRef.current = null
            setConnectionStatus(false)
          }
        })

    };
        
    initializeChannel();

    return () => {
      channelRef.current?.send({
        type: 'broadcast',
        event: PRESENCE_LEAVE_EVENT,
        payload: createPresencePayload(),
      })
      lifecycle.teardown();
      channelRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomName, userId, hasUser, setConnectionStatus, setCurrentUser, syncRemotePresence, createPresencePayload])

  // Update presence when selected layer changes
  useEffect(() => {
    if (channelRef.current && userId) {
      channelRef.current.send({
        type: 'broadcast',
        event: PRESENCE_SYNC_EVENT,
        payload: createPresencePayload(),
      });
    }

    // Mirror the change into the local collaboration store so getUsersByLayer
    // and related selectors stay accurate without coupling to mousemove.
    if (user?.id) {
      const { updateUser: storeUpdateUser } = useCollaborationPresenceStore.getState();
      storeUpdateUser(user.id, {
        selected_layer_id: selectedLayerId,
        last_active: Date.now(),
      });
    }
  }, [selectedLayerId, userId, user?.id, createPresencePayload]);

  useEffect(() => {
    // Handle mouse leaving the window - broadcast off-screen position
    const handleMouseLeave = () => {
      if (channelRef.current && cursorPayload.current) {
        channelRef.current.send({
          type: 'broadcast',
          event: EVENT_NAME,
          payload: {
            ...cursorPayload.current,
            position: { x: -1000, y: -1000 }, // Off-screen to hide cursor
            timestamp: Date.now(),
          },
        });
      }
    };

    // Add event listeners
    window.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseleave', handleMouseLeave)

    // Cleanup on unmount
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseleave', handleMouseLeave)
    }
  }, [handleMouseMove])

  return { cursors }
}
