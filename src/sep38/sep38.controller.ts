import { Controller, Get, Post, Body, Query, Param, NotFoundException, BadRequestException } from '@nestjs/common';
import { Sep38Service } from './sep38.service';
import { GetPricesDto, GetPriceDto, CreateQuoteDto } from './sep38.dto';

@Controller('sep38')
export class Sep38Controller {
  constructor(private readonly sep38Service: Sep38Service) {}

  @Get('prices')
  async getPrices(@Query() query: GetPricesDto) {
    return await this.sep38Service.getPrices(query.sell_asset, query.sell_amount);
  }

  @Get('price')
  async getPrice(@Query() query: GetPriceDto) {
    try {
      return await this.sep38Service.getPrice(query);
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }

  @Post('quote')
  async createQuote(@Body() dto: CreateQuoteDto) {
    try {
      return await this.sep38Service.createQuote(dto);
    } catch (error) {
      throw new BadRequestException(error.message);
    }
  }

  @Get('quote/:id')
  async getQuote(@Param('id') id: string) {
    const quote = await this.sep38Service.getQuote(id);
    if (!quote) {
      throw new NotFoundException(`Quote with ID ${id} not found or expired`);
    }
    return quote;
  }
}
