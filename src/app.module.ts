import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { WebSocketGatewayModule } from './websocket/websocket-gateway.module';
import { RedisModule } from './redis/redis.module';
import { Sep38Module } from './sep38/sep38.module';
import { TenantDataLeakageInterceptor } from './interceptors/tenant-data-leakage.interceptor';
import { TenantRouterService } from './services/tenant-router.service';
import { DatabaseConnectionFactory } from './services/database-connection.factory';
import { WebSocketRecoveryGateway } from './websocket/websocket-recovery.gateway';
import { TenantDatabaseRoutingMiddleware } from './middleware/tenant-database-routing.middleware';

@Module({
  imports: [
    AuthModule,
    WebSocketGatewayModule,
    RedisModule,
    Sep38Module,
  ],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: TenantDataLeakageInterceptor,
    },
    TenantRouterService,
    DatabaseConnectionFactory,
    WebSocketRecoveryGateway,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(TenantDatabaseRoutingMiddleware)
      .forRoutes('*'); // Apply to all routes
  }
}
