/**
 * Redis-backed realtime publisher / subscriber.
 */

import Redis from 'ioredis';

import type { RealtimeMessage, RealtimePublisher, RealtimeSubscriber } from './realtime';

const globalForRedis = globalThis as unknown as {
  __ycodeRedisPub?: Redis;
  __ycodeRedisSub?: Redis;
};

function redisUrl(): string {
  return process.env.REDIS_URL || 'redis://127.0.0.1:6379';
}

function getPubClient(): Redis {
  if (!globalForRedis.__ycodeRedisPub) {
    globalForRedis.__ycodeRedisPub = new Redis(redisUrl(), {
      maxRetriesPerRequest: 2,
      lazyConnect: true,
    });
  }
  return globalForRedis.__ycodeRedisPub;
}

function getSubClient(): Redis {
  if (!globalForRedis.__ycodeRedisSub) {
    globalForRedis.__ycodeRedisSub = new Redis(redisUrl(), {
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });
  }
  return globalForRedis.__ycodeRedisSub;
}

function channelKey(channel: string): string {
  return `ycode:rt:${channel}`;
}

export function createRedisPublisher(): RealtimePublisher {
  return {
    async publish(channel, message) {
      const client = getPubClient();
      if (client.status !== 'ready') {
        try {
          await client.connect();
        } catch {
          // already connecting / connected
        }
      }
      await client.publish(channelKey(channel), JSON.stringify(message));
    },
  };
}

export function createRedisSubscriber(): RealtimeSubscriber {
  return {
    async subscribe(channel, onMessage) {
      const client = getSubClient();
      if (client.status !== 'ready') {
        try {
          await client.connect();
        } catch {
          // ignore
        }
      }

      const key = channelKey(channel);
      const handler = (ch: string, raw: string) => {
        if (ch !== key) return;
        try {
          const parsed = JSON.parse(raw) as RealtimeMessage;
          onMessage(parsed);
        } catch {
          // ignore bad payload
        }
      };

      client.on('message', handler);
      await client.subscribe(key);

      return async () => {
        client.off('message', handler);
        try {
          await client.unsubscribe(key);
        } catch {
          // ignore
        }
      };
    },
  };
}
