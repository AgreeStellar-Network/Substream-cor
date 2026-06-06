import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { RedisService } from '../redis/redis.service';
import { DunningService } from './dunning.service';

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

@WebSocketGateway({
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true,
  },
  namespace: '/merchant',
})
export class MerchantWebSocketGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(MerchantWebSocketGateway.name);
  private readonly HEARTBEAT_INTERVAL = 30000;
  private readonly CONNECTION_TIMEOUT = 5 * 60 * 1000;
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
      const token = client.handshake.auth.token || client.handshake.headers.authorization?.replace('Bearer ', '');
      
      if (!token) {
        throw new UnauthorizedException('No token provided');
      }

      const stellarPublicKey = await this.authService.extractPublicKeyFromToken(token);
      
      client.stellarPublicKey = stellarPublicKey;
      client.token = token;

      await client.join(stellarPublicKey);

      this.setupHeartbeat(client);
      this.setupConnectionTimeout(client);

      this.logger.log(`Client connected: ${client.id} for merchant: ${stellarPublicKey}`);

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
  handlePing(@ConnectedSocket() client: SocketWithAuth) {
    this.resetConnectionTimeout(client);
    client.emit('pong', { timestamp: new Date().toISOString() });
  }

  async handlePaymentSuccess(payload: PaymentSuccessPayload) {
    this.logger.log(`Payment success for merchant: ${payload.stellarPublicKey}`);
    
    this.server.to(payload.stellarPublicKey).emit('payment_success', {
      type: 'payment_success',
      data: payload,
      timestamp: new Date().toISOString(),
    });

    await this.redisService.publish('payment_success', payload);
  }

  async handlePaymentFailure(payload: PaymentFailedPayload) {
    this.logger.log(`Payment failure for merchant: ${payload.stellarPublicKey}`);
    
    const processedPayload = await this.dunningService.processPaymentFailure(payload);
    
    if (processedPayload) {
      this.server.to(payload.stellarPublicKey).emit('payment_failed', {
        type: 'payment_failed',
        data: processedPayload,
        timestamp: new Date().toISOString(),
      });

      await this.redisService.publish('payment_failed', processedPayload);
    }
  }

  async handleTrialConverted(payload: TrialConvertedPayload) {
    this.logger.log(`Trial converted for merchant: ${payload.stellarPublicKey}`);
    
    this.server.to(payload.stellarPublicKey).emit('trial_converted', {
      type: 'trial_converted',
      data: payload,
      timestamp: new Date().toISOString(),
    });

    await this.redisService.publish('trial_converted', payload);
  }

  private setupHeartbeat(client: SocketWithAuth) {
    const interval = setInterval(() => {
      if (client.token && this.authService.isTokenExpired(client.token)) {
        this.logger.log(`Token expired for client ${client.id}, disconnecting...`);
        client.emit('token_expired', { message: 'Authentication token expired' });
        client.disconnect(true);
        return;
      }
      
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
    this.redisService.subscribe('payment_success', (payload: PaymentSuccessPayload) => {
      this.server.to(payload.stellarPublicKey).emit('payment_success', {
        type: 'payment_success',
        data: payload,
        timestamp: new Date().toISOString(),
      });
    });

    this.redisService.subscribe('payment_failed', (payload: PaymentFailedPayload) => {
      this.server.to(payload.stellarPublicKey).emit('payment_failed', {
        type: 'payment_failed',
        data: payload,
        timestamp: new Date().toISOString(),
      });
    });

    this.redisService.subscribe('trial_converted', (payload: TrialConvertedPayload) => {
      this.server.to(payload.stellarPublicKey).emit('trial_converted', {
        type: 'trial_converted',
        data: payload,
        timestamp: new Date().toISOString(),
      });
    });
  }

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
