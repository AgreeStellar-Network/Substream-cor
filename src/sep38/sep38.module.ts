import { Module } from '@nestjs/common';
import { Sep38Controller } from './sep38.controller';
import { Sep38Service } from './sep38.service';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [RedisModule],
  controllers: [Sep38Controller],
  providers: [Sep38Service],
  exports: [Sep38Service],
})
export class Sep38Module {}
