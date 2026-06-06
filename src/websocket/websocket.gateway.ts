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
}

interface PaymentSuccessPayload {
  stellarPublicKey: string;
  planId: string;
  amount: string;
  timestamp: string;
  transactionHash: string;
}

interface PaymentFailedPayload {
  stellarPublicKey: string;
  planId: string;
  userId: string;
  failureReason: string;
  timestamp: string;
  deepLinkRef: string;
}

interface TrialConvertedPayload {
  stellarPublicKey: string;
  planId: string;
  userId: string;
  timestamp: string;
}

interface MRRUpdatePayload {
  creator_id: string;
  payload: {
    type: string;
    metrics: {
      total_mrr: number;
      active_subscribers: number;
      currency: string;
      mrr_gained_today: number;
      mrr_lost_to_churn: number;
      churn_rate: number;
      average_revenue_per_user: number;
    };
    deltas: {
      mrr: {
        previous: number;
        current: number;
        change: number;
        change_percent: number;
      };
      subscribers: {
        previous: number;
        current: number;
        change: number;
      };
    };
    breakdowns: {
      by_plan: any[];
      by_cohort: any[];
      recent_activity: any[];
    };
  };
}

@WS_Gateway({
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true,
  },
  namespace: '/merchant',
})
export class WebSocketGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WS_Server()
  server!: Server;

  private readonly logger = new Logger(WebSocketGateway.name);
  private readonly HEARTBEAT_INTERVAL = 30000; // 30 seconds
  private readonly CONNECTION_TIMEOUT = 5 * 60 * 1000; // 5 minutes
  private heartbeatIntervals = new Map<string, NodeJS.Timeout>();
  private connectionTimeouts = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly authService: AuthService,
    private readonly redisService: RedisService,
    private readonly dunningService: DunningService,
  ) {}

  afterInit(server: Server) {
    this.logger.log('WebSocket Gateway initialized');
    this.setupRedisSubscriptions();
  }

  async handleConnection(client: SocketWithAuth) {
    try {
      // Extract JWT token from handshake headers
      const token = client.handshake.auth.token || client.handshake.headers.authorization?.replace('Bearer ', '');
      
      if (!token) {
        throw new UnauthorizedException('No token provided');
      }

      // Validate SEP-10 JWT token
      const stellarPublicKey = await this.authService.extractPublicKeyFromToken(token);
      
      // Attach public key to socket
      client.stellarPublicKey = stellarPublicKey;
      client.token = token;

      // Join merchant-specific room
      await client.join(stellarPublicKey);

      // Setup heartbeat and timeout
      this.setupHeartbeat(client);
      this.setupConnectionTimeout(client);

      this.logger.log(`Client connected: ${client.id} for merchant: ${stellarPublicKey}`);

      // Send welcome message
      client.emit('connected', {
        message: 'Successfully connected to AgreeStellar',
        merchantId: stellarPublicKey,
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

  // Payment success event handler
  async handlePaymentSuccess(payload: PaymentSuccessPayload) {
    this.logger.log(`Payment success for merchant: ${payload.stellarPublicKey}`);
    
    // Emit to specific merchant room
    this.server.to(payload.stellarPublicKey).emit('payment_success', {
      type: 'payment_success',
      data: payload,
      timestamp: new Date().toISOString(),
    });

    // Publish to Redis for cross-pod communication
    await this.redisService.publish('payment_success', payload);
  }

  // Payment failure event handler
  async handlePaymentFailure(payload: PaymentFailedPayload) {
    this.logger.log(`Payment failure for merchant: ${payload.stellarPublicKey}`);
    
    // Handle through dunning service for batching/debouncing
    const processedPayload = await this.dunningService.processPaymentFailure(payload);
    
    if (processedPayload) {
      // Emit to specific merchant room
      this.server.to(payload.stellarPublicKey).emit('payment_failed', {
        type: 'payment_failed',
        data: processedPayload,
        timestamp: new Date().toISOString(),
      });

      // Publish to Redis for cross-pod communication
      await this.redisService.publish('payment_failed', processedPayload);
    }
  }

  // Trial conversion event handler
  async handleTrialConverted(payload: TrialConvertedPayload) {
    this.logger.log(`Trial converted for merchant: ${payload.stellarPublicKey}`);
    
    // Emit to specific merchant room
    this.server.to(payload.stellarPublicKey).emit('trial_converted', {
      type: 'trial_converted',
      data: payload,
      timestamp: new Date().toISOString(),
    });

    // Publish to Redis for cross-pod communication
    await this.redisService.publish('trial_converted', payload);
  }

  // MRR update event handler
  async handleMRRUpdate(payload: MRRUpdatePayload) {
    this.logger.log(`MRR update for merchant: ${payload.creator_id}`);
    
    // Emit to specific merchant room
    this.server.to(payload.creator_id).emit('mrr_update', {
      type: 'mrr_update',
      data: payload.payload,
      timestamp: new Date().toISOString(),
    });
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
    this.redisService.subscribe('payment_success', (payload: PaymentSuccessPayload) => {
      this.server.to(payload.stellarPublicKey).emit('payment_success', {
        type: 'payment_success',
        data: payload,
        timestamp: new Date().toISOString(),
      });
    });

    // Subscribe to payment failure events
    this.redisService.subscribe('payment_failed', (payload: PaymentFailedPayload) => {
      this.server.to(payload.stellarPublicKey).emit('payment_failed', {
        type: 'payment_failed',
        data: payload,
        timestamp: new Date().toISOString(),
      });
    });

    // Subscribe to trial conversion events
    this.redisService.subscribe('trial_converted', (payload: TrialConvertedPayload) => {
      this.server.to(payload.stellarPublicKey).emit('trial_converted', {
        type: 'trial_converted',
        data: payload,
        timestamp: new Date().toISOString(),
      });
    });

    // Subscribe to MRR update events
    this.redisService.subscribe('mrr_update', (payload: MRRUpdatePayload) => {
      this.handleMRRUpdate(payload);
    });
  }

  // Public methods for external event emission
  async emitPaymentSuccess(payload: PaymentSuccessPayload) {
    await this.handlePaymentSuccess(payload);
  }

  async emitPaymentFailure(payload: PaymentFailedPayload) {
    await this.handlePaymentFailure(payload);
  }

  async emitTrialConverted(payload: TrialConvertedPayload) {
    await this.handleTrialConverted(payload);
  }
}
