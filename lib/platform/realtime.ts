/**
 * Realtime port — Redis pub/sub + SSE (replaces Supabase Realtime).
 */

export interface RealtimeMessage {
  event: string;
  payload: unknown;
}

export interface RealtimePublisher {
  publish(channel: string, message: RealtimeMessage): Promise<void>;
}

export interface RealtimeSubscriber {
  subscribe(
    channel: string,
    onMessage: (message: RealtimeMessage) => void
  ): Promise<() => Promise<void>>;
}

let publisher: RealtimePublisher | null = null;

export function setRealtimePublisher(p: RealtimePublisher): void {
  publisher = p;
}

export async function getRealtimePublisher(): Promise<RealtimePublisher> {
  if (publisher) return publisher;
  const { createRedisPublisher } = await import('./realtime-redis');
  publisher = createRedisPublisher();
  return publisher;
}

export async function publishRealtime(
  channel: string,
  event: string,
  payload: unknown
): Promise<void> {
  const p = await getRealtimePublisher();
  await p.publish(channel, { event, payload });
}
