import { IsString, IsNotEmpty, IsOptional, Matches, MaxLength, MinLength, IsArray, IsEnum, ArrayMaxSize } from 'class-validator';
import { Transform } from 'class-transformer';
import { sanitizeString } from './sanitization.util';

export class LoginDto {
  @IsString() @IsNotEmpty() @MaxLength(56)
  @Matches(/^G[A-Z2-7]{55}$/, { message: 'stellarPublicKey must be a valid Stellar public key' })
  stellarPublicKey: string;

  @IsString() @IsNotEmpty() @MinLength(3) @MaxLength(63)
  @Matches(/^[a-z0-9-]+$/, { message: 'organizationSlug must contain only lowercase letters, numbers, and hyphens' })
  @Transform(({ value }) => sanitizeString(value))
  organizationSlug: string;

  @IsOptional() @IsString() @MaxLength(256)
  @Matches(/^[a-fA-F0-9]{128}$/, { message: 'signature must be a 128-character hex string' })
  signature?: string;
}

export class VerifyStellarSignatureDto {
  @IsString() @IsNotEmpty() @MaxLength(56)
  @Matches(/^G[A-Z2-7]{55}$/, { message: 'publicKey must be a valid Stellar public key' })
  publicKey: string;

  @IsString() @IsNotEmpty() @MaxLength(256)
  @Matches(/^[a-fA-F0-9]{128}$/, { message: 'signature must be a 128-character hex string' })
  signature: string;

  @IsString() @IsNotEmpty() @MaxLength(512)
  @Transform(({ value }) => sanitizeString(value))
  message: string;
}

export enum ApiKeyPermission {
  STREAM_READ = 'stream:read',
  STREAM_WRITE = 'stream:write',
  SUBSCRIPTION_READ = 'subscription:read',
  SUBSCRIPTION_WRITE = 'subscription:write',
  API_KEYS_CREATE = 'api_keys:create',
  API_KEYS_REVOKE = 'api_keys:revoke',
  MEMBERS_READ = 'members:read',
  MEMBERS_WRITE = 'members:write',
  MEMBERS_INVITE = 'members:invite',
  MEMBERS_DELETE = 'members:delete',
  BILLING_READ = 'billing:read',
  BILLING_WRITE = 'billing:write',
}

export class CreateApiKeyDto {
  @IsOptional() @IsArray() @ArrayMaxSize(20)
  @IsEnum(ApiKeyPermission, { each: true, message: 'Each permission must be a valid permission scope' })
  permissions?: ApiKeyPermission[];
}
