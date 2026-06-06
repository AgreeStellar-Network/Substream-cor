import {
  WebSocketGateway as WS_Gateway,
  WebSocketServer as WS_Server,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, UseGuards, UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { RedisService } from '../redis/redis.service';
import { DunningService } from './dunning.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

interface SocketWithAuth extends Socket {
  stellarPublicKey?: string;
  token?: string;
  lastMessageId?: number;
  reconnectAttempts?: number;
}

interface MessageBuffer {
  messageId: number;
  event: string;
  data: any;
  timestamp: number;
}

interface ClientHandshake {
  token: string;
  lastMessageId?: number;
  reconnectAttempt?: number;
}

@WS_Gateway({
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true,
  },
  namespace: '/merchant',
})
export class WebSocketRecoveryGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WS_Server()
  server!: Server;

  private readonly logger = new Logger(WebSocketRecoveryGateway.name);
  private readonly HEARTBEAT_INTERVAL = 25000; // 25 seconds as required
  private readonly CONNECTION_TIMEOUT = 5 * 60 * 1000; // 5 minutes
  private readonly MAX_BUFFER_SIZE = 500; // Maximum events per merchant
  private readonly MAX_RECONNECT_ATTEMPTS = 5;
  private readonly RECONNECT_BACKOFF_BASE = 1000; // 1 second base
  
  private heartbeatIntervals = new Map<string, NodeJS.Timeout>();
  private connectionTimeouts = new Map<string, NodeJS.Timeout>();
  private messageBuffers = new Map<string, MessageBuffer[]>(); // merchantId -> buffer
  private messageIdCounter = new Map<string, number>(); // merchantId -> counter
  private lastAckedMessageId = new Map<string, number>(); // merchantId -> last acked ID

  constructor(
    private readonly authService: AuthService,
    private readonly redisService: RedisService,
    private readonly dunningService: DunningService,
  ) {}

  afterInit(server: Server) {
    this.logger.log('WebSocket Recovery Gateway initialized');
    this.setupRedisSubscriptions();
    this.startBufferCleanup();
  }

  async handleConnection(client: SocketWithAuth) {
    try {
      // Extract handshake data
      const handshake: ClientHandshake = client.handshake.auth;
      
      if (!handshake.token) {
        throw new UnauthorizedException('No token provided');
      }

      // Validate SEP-10 JWT token
      const stellarPublicKey = await this.authService.extractPublicKeyFromToken(handshake.token);
      
      // Attach public key to socket
      client.stellarPublicKey = stellarPublicKey;
      client.token = handshake.token;
      client.lastMessageId = handshake.lastMessageId;
      client.reconnectAttempts = handshake.reconnectAttempt || 0;

      // Join merchant-specific room
      await client.join(stellarPublicKey);

      // Initialize message counter if not exists
      if (!this.messageIdCounter.has(stellarPublicKey)) {
        this.messageIdCounter.set(stellarPublicKey, 0);
        this.lastAckedMessageId.set(stellarPublicKey, 0);
        this.messageBuffers.set(stellarPublicKey, []);
      }

      // Handle reconnection: replay missed messages
      if (handshake.lastMessageId !== undefined) {
        await this.handleReconnection(client, stellarPublicKey, handshake.lastMessageId);
      }

      // Setup heartbeat and timeout
      this.setupHeartbeat(client);
      this.setupConnectionTimeout(client);

      this.logger.log(`Client connected: ${client.id} for merchant: ${stellarPublicKey} (reconnect: ${client.reconnectAttempts})`);

      // Send welcome message with current message ID
      const currentMessageId = this.messageIdCounter.get(stellarPublicKey) || 0;
      client.emit('connected', {
        message: 'Successfully connected to AgreeStellar',
        merchantId: stellarPublicKey,
        currentMessageId,
        timestamp: new Date().toISOString(),
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Connection failed for client ${client.id}: ${errorMessage}`);
      client.emit('error', { message: 'Authentication failed' });
      client.disconnect(true);
    }
  }

  async handleDisconnect(client: SocketWithAuth) {
    const stellarPublicKey = client.stellarPublicKey;
    
    // Clear intervals and timeouts
    const heartbeatInterval = this.heartbeatIntervals.get(client.id);
    const connectionTimeout = this.connectionTimeouts.get(client.id);
    
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      this.heartbeatIntervals.delete(client.id);
    }
    
    if (connectionTimeout) {
      clearTimeout(connectionTimeout);
      this.connectionTimeouts.delete(client.id);
    }

    this.logger.log(`Client disconnected: ${client.id} for merchant: ${stellarPublicKey}`);
  }

  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() client: SocketWithAuth): void {
    // Reset connection timeout on ping
    this.resetConnectionTimeout(client);
    client.emit('pong', { timestamp: new Date().toISOString() });
  }

  @SubscribeMessage('ack')
  handleAck(
    @ConnectedSocket() client: SocketWithAuth,
    @MessageBody() data: { messageId: number },
  ): void {
    const stellarPublicKey = client.stellarPublicKey;
    if (!stellarPublicKey) return;

    // Update last acknowledged message ID
    this.lastAckedMessageId.set(stellarPublicKey, data.messageId);
    
    // Clean up messages that have been acknowledged
    this.cleanupAcknowledgedMessages(stellarPublicKey, data.messageId);
    
    this.logger.debug(`Received ACK for message ${data.messageId} from ${stellarPublicKey}`);
  }

  // Enhanced event emission with message ID and buffering
  async emitToMerchant(merchantId: string, event: string, data: any): Promise<void> {
    const messageId = this.getNextMessageId(merchantId);
    const message: MessageBuffer = {
      messageId,
      event,
      data,
      timestamp: Date.now(),
    };

    // Add to buffer
    await this.addToBuffer(merchantId, message);

    // Emit to merchant room with message ID
    this.server.to(merchantId).emit(event, {
      messageId,
      data,
      timestamp: new Date().toISOString(),
    });

    // Also publish to Redis for cross-pod communication
    await this.redisService.publish('websocket_event', {
      merchantId,
      event,
      messageId,
      data,
      timestamp: new Date().toISOString(),
    });
  }

  // Payment success event handler (enhanced)
  async handlePaymentSuccess(payload: any) {
    this.logger.log(`Payment success for merchant: ${payload.stellarPublicKey}`);
    await this.emitToMerchant(payload.stellarPublicKey, 'payment_success', payload);
  }

  // Payment failure event handler (enhanced)
  async handlePaymentFailure(payload: any) {
    this.logger.log(`Payment failure for merchant: ${payload.stellarPublicKey}`);
    
    const processedPayload = await this.dunningService.processPaymentFailure(payload);
    if (processedPayload) {
      await this.emitToMerchant(payload.stellarPublicKey, 'payment_failed', processedPayload);
    }
  }

  // Trial conversion event handler (enhanced)
  async handleTrialConverted(payload: any) {
    this.logger.log(`Trial converted for merchant: ${payload.stellarPublicKey}`);
    await this.emitToMerchant(payload.stellarPublicKey, 'trial_converted', payload);
  }

  // MRR update event handler (enhanced)
  async handleMRRUpdate(payload: any) {
    this.logger.log(`MRR update for merchant: ${payload.creator_id}`);
    await this.emitToMerchant(payload.creator_id, 'mrr_update', payload.payload);
  }

  private async handleReconnection(
    client: SocketWithAuth,
    merchantId: string,
    lastMessageId: number,
  ): Promise<void> {
    const buffer = this.messageBuffers.get(merchantId) || [];
    const currentMessageId = this.messageIdCounter.get(merchantId) || 0;
    
    // Check if buffer was cleared (too much time passed)
    if (buffer.length === 0 || lastMessageId < buffer[0]?.messageId) {
      client.emit('state_stale', {
        message: 'Too much time has passed since last connection',
        lastMessageId,
        currentMessageId,
        recommendation: 'Please refresh your data via REST API',
      });
      return;
    }

    // Find messages that occurred after the last acknowledged message
    const missedMessages = buffer.filter(msg => msg.messageId > lastMessageId);
    
    if (missedMessages.length > 0) {
      this.logger.log(`Replaying ${missedMessages.length} missed messages for ${merchantId}`);
      
      // Replay missed messages in order
      for (const message of missedMessages) {
        client.emit(message.event, {
          messageId: message.messageId,
          data: message.data,
          timestamp: new Date().toISOString(),
          replayed: true,
        });
        
        // Small delay to prevent overwhelming the client
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }

    // Send reconnection complete message
    client.emit('reconnection_complete', {
      messagesReplayed: missedMessages.length,
      lastMessageId: currentMessageId,
      timestamp: new Date().toISOString(),
    });
  }

  private async addToBuffer(merchantId: string, message: MessageBuffer): Promise<void> {
    let buffer = this.messageBuffers.get(merchantId) || [];
    
    // Add new message
    buffer.push(message);
    
    // Maintain buffer size limit
    if (buffer.length > this.MAX_BUFFER_SIZE) {
      const excess = buffer.length - this.MAX_BUFFER_SIZE;
      buffer = buffer.slice(excess);
    }
    
    this.messageBuffers.set(merchantId, buffer);
    
    // Also store in Redis for persistence across server restarts
    await this.redisService.lpush(
      `message_buffer:${merchantId}`,
      JSON.stringify(message)
    );
    
    // Keep only the latest MAX_BUFFER_SIZE messages in Redis
    await this.redisService.ltrim(`message_buffer:${merchantId}`, 0, this.MAX_BUFFER_SIZE - 1);
    await this.redisService.expire(`message_buffer:${merchantId}`, 3600); // 1 hour expiration
  }

  private getNextMessageId(merchantId: string): number {
    const currentId = this.messageIdCounter.get(merchantId) || 0;
    const nextId = currentId + 1;
    this.messageIdCounter.set(merchantId, nextId);
    return nextId;
  }

  private cleanupAcknowledgedMessages(merchantId: string, ackedMessageId: number): void {
    let buffer = this.messageBuffers.get(merchantId) || [];
    
    // Remove messages that have been acknowledged
    buffer = buffer.filter(msg => msg.messageId > ackedMessageId);
    
    this.messageBuffers.set(merchantId, buffer);
  }

  private setupHeartbeat(client: SocketWithAuth) {
    const interval = setInterval(() => {
      // Check if token is still valid
      if (client.token && this.authService.isTokenExpired(client.token)) {
        this.logger.log(`Token expired for client ${client.id}, disconnecting...`);
        client.emit('token_expired', { message: 'Authentication token expired' });
        client.disconnect(true);
        return;
      }
      
      // Send ping
      client.emit('ping', { timestamp: new Date().toISOString() });
    }, this.HEARTBEAT_INTERVAL);

    this.heartbeatIntervals.set(client.id, interval);
  }

  private setupConnectionTimeout(client: SocketWithAuth) {
    const timeout = setTimeout(() => {
      this.logger.log(`Connection timeout for client ${client.id}`);
      client.emit('timeout', { message: 'Connection timeout' });
      client.disconnect(true);
    }, this.CONNECTION_TIMEOUT);

    this.connectionTimeouts.set(client.id, timeout);
  }

  private resetConnectionTimeout(client: SocketWithAuth) {
    const timeout = this.connectionTimeouts.get(client.id);
    if (timeout) {
      clearTimeout(timeout);
    }
    
    const newTimeout = setTimeout(() => {
      this.logger.log(`Connection timeout for client ${client.id}`);
      client.emit('timeout', { message: 'Connection timeout' });
      client.disconnect(true);
    }, this.CONNECTION_TIMEOUT);
    
    this.connectionTimeouts.set(client.id, newTimeout);
  }

  private setupRedisSubscriptions() {
    // Subscribe to payment success events
    this.redisService.subscribe('payment_success', async (payload: any) => {
      await this.handlePaymentSuccess(payload);
    });

    // Subscribe to payment failure events
    this.redisService.subscribe('payment_failed', async (payload: any) => {
      await this.handlePaymentFailure(payload);
    });

    // Subscribe to trial conversion events
    this.redisService.subscribe('trial_converted', async (payload: any) => {
      await this.handleTrialConverted(payload);
    });

    // Subscribe to MRR update events
    this.redisService.subscribe('mrr_update', async (payload: any) => {
      await this.handleMRRUpdate(payload);
    });

    // Subscribe to cross-pod WebSocket events
    this.redisService.subscribe('websocket_event', async (event: any) => {
      await this.emitToMerchant(event.merchantId, event.event, event.data);
    });
  }

  private startBufferCleanup(): void {
    // Clean up old messages every 5 minutes
    setInterval(() => {
      const now = Date.now();
      const oneHour = 60 * 60 * 1000; // 1 hour in milliseconds
      
      for (const [merchantId, buffer] of this.messageBuffers.entries()) {
        // Remove messages older than 1 hour
        const cleanedBuffer = buffer.filter(msg => (now - msg.timestamp) < oneHour);
        this.messageBuffers.set(merchantId, cleanedBuffer);
      }
    }, 5 * 60 * 1000); // 5 minutes
  }

  // Public methods for external event emission
  async emitPaymentSuccess(payload: any) {
    await this.handlePaymentSuccess(payload);
  }

  async emitPaymentFailure(payload: any) {
    await this.handlePaymentFailure(payload);
  }

  async emitTrialConverted(payload: any) {
    await this.handleTrialConverted(payload);
  }

  // Get buffer statistics for monitoring
  getBufferStats(): { [merchantId: string]: { size: number; oldestMessage: number; newestMessage: number } } {
    const stats: { [key: string]: any } = {};
    
    for (const [merchantId, buffer] of this.messageBuffers.entries()) {
      if (buffer.length > 0) {
        stats[merchantId] = {
          size: buffer.length,
          oldestMessage: buffer[0].messageId,
          newestMessage: buffer[buffer.length - 1].messageId,
        };
      }
    }
    
    return stats;
  }
}
