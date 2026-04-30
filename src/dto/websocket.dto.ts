import { IsString, IsNotEmpty, IsOptional, IsEnum, IsNumberString, Matches, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { sanitizeString } from './sanitization.util';

export enum SubscriptionEventType {
  PAYMENT_SUCCESS = 'payment_success',
  PAYMENT_FAILED = 'payment_failed',
  TRIAL_CONVERTED = 'trial_converted',
  MRR_UPDATE = 'mrr_update',
  SUBSCRIPTION_EXPIRED = 'subscription_expired',
  SUBSCRIPTION_RENEWED = 'subscription_renewed',
}

export class SubscribeToStreamDto {
  @IsString() @IsNotEmpty() @MaxLength(56)
  @Matches(/^G[A-Z2-7]{55}$/, { message: 'stellarPublicKey must be a valid Stellar public key' })
  stellarPublicKey: string;

  @IsOptional()
  @IsEnum(SubscriptionEventType, { message: 'eventType must be a valid subscription event type' })
  eventType?: SubscriptionEventType;
}

export class PaymentSuccessPayloadDto {
  @IsString() @IsNotEmpty() @MaxLength(56)
  @Matches(/^G[A-Z2-7]{55}$/, { message: 'stellarPublicKey must be a valid Stellar public key' })
  stellarPublicKey: string;

  @IsString() @IsNotEmpty() @MaxLength(64)
  @Matches(/^[a-zA-Z0-9_-]+$/, { message: 'planId must contain only alphanumeric characters, underscores, and hyphens' })
  @Transform(({ value }) => sanitizeString(value))
  planId: string;

  @IsString() @IsNotEmpty() @IsNumberString({}, { message: 'amount must be a numeric string' }) @MaxLength(32)
  amount: string;

  @IsString() @IsNotEmpty() @MaxLength(64)
  @Matches(/^[a-fA-F0-9]+$/, { message: 'transactionHash must be a hexadecimal string' })
  transactionHash: string;
}
