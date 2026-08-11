import { NextRequest } from 'next/server';

import { createRedisSubscriber } from '@/lib/platform/realtime-redis';
import { getAuthUser } from '@/lib/platform/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * SSE subscribe endpoint — streams Redis pub/sub messages for one channel.
 */
export async function GET(request: NextRequest) {
  const auth = await getAuthUser();
  if (!auth?.user) {
    return new Response('Unauthorized', { status: 401 });
  }

  const channel = request.nextUrl.searchParams.get('channel');
  if (!channel) {
    return new Response('channel required', { status: 400 });
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => Promise<void>) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': ping\n\n'));
        } catch {
          // closed
        }
      }, 15000);

      try {
        const subscriber = createRedisSubscriber();
        unsubscribe = await subscriber.subscribe(channel, (message) => {
          send(message);
        });
        send({ event: '_connected', payload: { channel } });
      } catch (error) {
        send({
          event: '_error',
          payload: {
            message: error instanceof Error ? error.message : 'subscribe failed',
          },
        });
      }
    },
    async cancel() {
      if (heartbeat) clearInterval(heartbeat);
      if (unsubscribe) await unsubscribe();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
