import { IsString, IsNotEmpty, IsOptional, IsEmail, IsEnum, Matches, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { sanitizeString } from './sanitization.util';

export enum MemberRole {
  ADMIN = 'ADMIN',
  VIEWER = 'VIEWER',
  BILLING_MANAGER = 'BILLING_MANAGER',
}

export enum MemberStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  SUSPENDED = 'SUSPENDED',
}

export class CreateOrganizationDto {
  @IsString() @IsNotEmpty() @MinLength(2) @MaxLength(100)
  @Transform(({ value }) => sanitizeString(value))
  name: string;

  @IsString() @IsNotEmpty() @MinLength(3) @MaxLength(63)
  @Matches(/^[a-z0-9-]+$/, { message: 'slug must contain only lowercase letters, numbers, and hyphens' })
  @Transform(({ value }) => typeof value === 'string' ? value.toLowerCase().trim() : value)
  slug: string;

  @IsOptional() @IsString() @MaxLength(253)
  @Matches(/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/, { message: 'domain must be a valid hostname' })
  @Transform(({ value }) => sanitizeString(value))
  domain?: string;

  @IsOptional() @IsString() @MaxLength(500)
  @Transform(({ value }) => sanitizeString(value))
  description?: string;
}

export class UpdateOrganizationDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(100)
  @Transform(({ value }) => sanitizeString(value))
  name?: string;

  @IsOptional() @IsString() @MaxLength(253)
  @Matches(/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/, { message: 'domain must be a valid hostname' })
  @Transform(({ value }) => sanitizeString(value))
  domain?: string;

  @IsOptional() @IsString() @MaxLength(500)
  @Transform(({ value }) => sanitizeString(value))
  description?: string;
}

export class AddMemberDto {
  @IsEmail({}, { message: 'email must be a valid email address' }) @MaxLength(254)
  @Transform(({ value }) => typeof value === 'string' ? value.toLowerCase().trim() : value)
  email: string;

  @IsEnum(MemberRole, { message: 'role must be one of: ADMIN, VIEWER, BILLING_MANAGER' })
  role: MemberRole;

  @IsOptional() @IsString() @MaxLength(56)
  @Matches(/^G[A-Z2-7]{55}$/, { message: 'stellarPublicKey must be a valid Stellar public key' })
  stellarPublicKey?: string;
}

export class UpdateMemberDto {
  @IsOptional()
  @IsEnum(MemberRole, { message: 'role must be one of: ADMIN, VIEWER, BILLING_MANAGER' })
  role?: MemberRole;

  @IsOptional()
  @IsEnum(MemberStatus, { message: 'status must be one of: ACTIVE, INACTIVE, SUSPENDED' })
  status?: MemberStatus;
}
