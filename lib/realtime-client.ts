/**
 * Client realtime channel — SSE subscribe + HTTP publish (replaces Supabase Realtime).
 */

export type BroadcastHandler = (message: { payload: unknown; event: string }) => void;

export interface YcodeRealtimeChannel {
  on(
    type: 'broadcast',
    filter: { event: string },
    handler: BroadcastHandler
  ): YcodeRealtimeChannel;
  send(message: { type: 'broadcast'; event: string; payload: unknown }): Promise<void>;
  subscribe(cb?: (status: string) => void): YcodeRealtimeChannel;
  unsubscribe(): void;
}

class SseRealtimeChannel implements YcodeRealtimeChannel {
  private handlers = new Map<string, Set<BroadcastHandler>>();
  private source: EventSource | null = null;
  private closed = false;

  constructor(private readonly channelName: string) {}

  on(
    _type: 'broadcast',
    filter: { event: string },
    handler: BroadcastHandler
  ): YcodeRealtimeChannel {
    const set = this.handlers.get(filter.event) || new Set();
    set.add(handler);
    this.handlers.set(filter.event, set);
    return this;
  }

  async send(message: { type: 'broadcast'; event: string; payload: unknown }): Promise<void> {
    await fetch('/ycode/api/realtime/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: this.channelName,
        event: message.event,
        payload: message.payload,
      }),
    });
  }

  subscribe(cb?: (status: string) => void): YcodeRealtimeChannel {
    if (this.closed) return this;

    const url = `/ycode/api/realtime/sse?channel=${encodeURIComponent(this.channelName)}`;
    this.source = new EventSource(url);

    this.source.onopen = () => cb?.('SUBSCRIBED');
    this.source.onerror = () => cb?.('CHANNEL_ERROR');
    this.source.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data) as { event: string; payload: unknown };
        const set = this.handlers.get(data.event);
        if (!set) return;
        for (const handler of set) {
          handler({ event: data.event, payload: data.payload });
        }
      } catch {
        // ignore malformed
      }
    };

    return this;
  }

  unsubscribe(): void {
    this.closed = true;
    this.source?.close();
    this.source = null;
    this.handlers.clear();
  }
}

/** Create a realtime channel by name (e.g. pages:updates). */
export function createRealtimeChannel(channelName: string): YcodeRealtimeChannel {
  return new SseRealtimeChannel(channelName);
}

/** Presence-style track via publish (best-effort; no server presence store required). */
export async function trackPresence(
  channelName: string,
  key: string,
  meta: Record<string, unknown>
): Promise<void> {
  await fetch('/ycode/api/realtime/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      channel: channelName,
      event: 'presence',
      payload: { key, meta },
    }),
  });
}
