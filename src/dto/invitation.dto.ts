import { IsString, IsNotEmpty, IsOptional, IsEmail, IsEnum, IsInt, Matches, MaxLength, Min, Max } from 'class-validator';
import { Transform } from 'class-transformer';
import { sanitizeString } from './sanitization.util';
import { MemberRole } from './organization.dto';

export class CreateInvitationDto {
  @IsEmail({}, { message: 'email must be a valid email address' }) @MaxLength(254)
  @Transform(({ value }) => typeof value === 'string' ? value.toLowerCase().trim() : value)
  email: string;

  @IsEnum(MemberRole, { message: 'role must be one of: ADMIN, VIEWER, BILLING_MANAGER' })
  role: MemberRole;

  @IsOptional() @IsString() @MaxLength(500)
  @Transform(({ value }) => sanitizeString(value))
  message?: string;

  @IsOptional() @IsInt() @Min(1) @Max(30)
  @Transform(({ value }) => value !== undefined ? parseInt(value, 10) : undefined)
  expiresInDays?: number;
}

export class AcceptInvitationDto {
  @IsString() @IsNotEmpty() @MaxLength(56)
  @Matches(/^G[A-Z2-7]{55}$/, { message: 'stellarPublicKey must be a valid Stellar public key' })
  stellarPublicKey: string;
}
