import { NextRequest, NextResponse } from 'next/server';

import { publishRealtime } from '@/lib/platform/realtime';
import { getAuthUser } from '@/lib/platform/auth';

/**
 * Publish a realtime event to a channel (Redis pub/sub).
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthUser();
    if (!auth?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json() as {
      channel?: string;
      event?: string;
      payload?: unknown;
    };

    if (!body.channel || !body.event) {
      return NextResponse.json(
        { error: 'channel and event are required' },
        { status: 400 }
      );
    }

    await publishRealtime(body.channel, body.event, body.payload ?? {});
    return NextResponse.json({ data: { ok: true } });
  } catch (error) {
    console.error('[realtime/publish]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Publish failed' },
      { status: 500 }
    );
  }
}
