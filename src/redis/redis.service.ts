import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private publisher!: Redis;
  private subscriber!: Redis;
  private buffer: Map<string, any[]> = new Map();
  private isReconnecting = false;

  async onModuleInit() {
    await this.initializeConnections();
  }

  async onModuleDestroy() {
    await this.disconnect();
  }

  private async initializeConnections() {
    const redisUrl = process.env.REDIS_PUBSUB_URL || 'redis://localhost:6379';
    
    this.publisher = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });

    this.subscriber = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });

    // Handle connection events
    this.publisher.on('error', (error) => {
      console.error('Redis publisher error:', error);
      this.handleReconnection();
    });

    this.subscriber.on('error', (error) => {
      console.error('Redis subscriber error:', error);
      this.handleReconnection();
    });

    this.publisher.on('connect', () => {
      console.log('Redis publisher connected');
      this.flushBuffer();
    });

    this.subscriber.on('connect', () => {
      console.log('Redis subscriber connected');
    });

    try {
      await this.publisher.connect();
      await this.subscriber.connect();
    } catch (error) {
      console.error('Failed to connect to Redis:', error);
      this.handleReconnection();
    }
  }

  private async handleReconnection() {
    if (this.isReconnecting) return;
    
    this.isReconnecting = true;
    console.log('Attempting to reconnect to Redis...');
    
    setTimeout(async () => {
      try {
        await this.initializeConnections();
        this.isReconnecting = false;
      } catch (error) {
        console.error('Reconnection failed, retrying...');
        this.handleReconnection();
      }
    }, 5000);
  }

  private async flushBuffer() {
    for (const [channel, messages] of this.buffer.entries()) {
      for (const message of messages) {
        await this.publish(channel, message);
      }
      this.buffer.delete(channel);
    }
  }

  async publish(channel: string, data: any): Promise<void> {
    const message = JSON.stringify(data);
    
    if (this.publisher.status === 'ready') {
      await this.publisher.publish(channel, message);
    } else {
      // Buffer the message if Redis is not ready
      if (!this.buffer.has(channel)) {
        this.buffer.set(channel, []);
      }
      this.buffer.get(channel).push(data);
      console.log(`Buffered message for channel ${channel} due to Redis disconnection`);
    }
  }

  async subscribe(channel: string, callback: (message: any) => void): Promise<void> {
    await this.subscriber.subscribe(channel);
    
    this.subscriber.on('message', (receivedChannel, message) => {
      if (receivedChannel === channel) {
        try {
          const data = JSON.parse(message);
          callback(data);
        } catch (error) {
          console.error('Failed to parse Redis message:', error);
        }
      }
    });
  }

  async unsubscribe(channel: string): Promise<void> {
    await this.subscriber.unsubscribe(channel);
  }

  private async disconnect() {
    if (this.publisher) {
      await this.publisher.quit();
    }
    if (this.subscriber) {
      await this.subscriber.quit();
    }
  }

  async set(key: string, value: any, ttlSeconds?: number): Promise<void> {
    const data = JSON.stringify(value);
    if (ttlSeconds) {
      await this.publisher.set(key, data, 'EX', ttlSeconds);
    } else {
      await this.publisher.set(key, data);
    }
  }

  async get<T>(key: string): Promise<T | null> {
    const data = await this.publisher.get(key);
    if (!data) return null;
    try {
      return JSON.parse(data) as T;
    } catch (error) {
      console.error(`Failed to parse Redis data for key ${key}:`, error);
      return null;
    }
  }

  async del(key: string): Promise<void> {
    await this.publisher.del(key);
  }

  async lpush(key: string, value: string): Promise<void> {
    await this.publisher.lpush(key, value);
  }

  async ltrim(key: string, start: number, end: number): Promise<void> {
    await this.publisher.ltrim(key, start, end);
  }

  async expire(key: string, seconds: number): Promise<void> {
    await this.publisher.expire(key, seconds);
  }

  getPublisherStatus(): string {
    return this.publisher.status;
  }

  getSubscriberStatus(): string {
    return this.subscriber.status;
  }
}
