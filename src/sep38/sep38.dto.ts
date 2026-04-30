import { IsString, IsNotEmpty, IsOptional, IsNumberString } from 'class-validator';

export class GetPricesDto {
  @IsString()
  @IsNotEmpty()
  sell_asset: string;

  @IsNumberString()
  @IsOptional()
  sell_amount?: string;
}

export class GetPriceDto {
  @IsString()
  @IsNotEmpty()
  sell_asset: string;

  @IsString()
  @IsNotEmpty()
  buy_asset: string;

  @IsNumberString()
  @IsOptional()
  sell_amount?: string;

  @IsNumberString()
  @IsOptional()
  buy_amount?: string;
}

export class CreateQuoteDto {
  @IsString()
  @IsNotEmpty()
  sell_asset: string;

  @IsString()
  @IsNotEmpty()
  buy_asset: string;

  @IsNumberString()
  @IsOptional()
  sell_amount?: string;

  @IsNumberString()
  @IsOptional()
  buy_amount?: string;

  @IsString()
  @IsOptional()
  context?: string;
}
