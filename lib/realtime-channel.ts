/**
 * Race-safe lifecycle wrapper for async-initialized realtime channels.
 */

import type { YcodeRealtimeChannel } from '@/lib/realtime-client';

export interface ChannelLifecycle {
  track: (channel: YcodeRealtimeChannel) => boolean;
  readonly cancelled: boolean;
  teardown: () => void;
}

/**
 * Race-safe lifecycle for SSE realtime channels.
 */
export function createChannelLifecycle(): ChannelLifecycle {
  let isCancelled = false;
  let trackedChannel: YcodeRealtimeChannel | null = null;

  return {
    track(channel) {
      if (isCancelled) {
        channel.unsubscribe();
        return false;
      }
      trackedChannel = channel;
      return true;
    },
    get cancelled() {
      return isCancelled;
    },
    teardown() {
      isCancelled = true;
      if (trackedChannel) {
        trackedChannel.unsubscribe();
        trackedChannel = null;
      }
    },
  };
}
