import { Injectable, Logger } from '@nestjs/common';
import { Asset, Horizon } from '@stellar/stellar-sdk';
import { RedisService } from '../redis/redis.service';
import { CreateQuoteDto } from './sep38.dto';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class Sep38Service {
  private readonly logger = new Logger(Sep38Service.name);
  private horizonServer: Horizon.Server;

  constructor(private readonly redisService: RedisService) {
    const horizonUrl = process.env.SANDBOX_STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';
    this.horizonServer = new Horizon.Server(horizonUrl);
  }

  /**
   * Parses a SEP-38 asset string into a Stellar SDK Asset.
   * Format: stellar:CODE:ISSUER or stellar:native
   */
  private parseAssetString(assetString: string): Asset {
    const parts = assetString.split(':');
    if (parts[0] !== 'stellar') {
      throw new Error(`Invalid asset schema: ${parts[0]}`);
    }

    if (parts[1] === 'native') {
      return Asset.native();
    }

    if (parts.length < 3) {
      throw new Error(`Invalid asset format: ${assetString}`);
    }

    return new Asset(parts[1], parts[2]);
  }

  /**
   * Formats a Stellar SDK Asset into a SEP-38 asset string.
   */
  private formatAssetString(asset: Asset): string {
    if (asset.isNative()) {
      return 'stellar:native';
    }
    return `stellar:${asset.getCode()}:${asset.getIssuer()}`;
  }

  /**
   * GET /prices
   */
  async getPrices(sellAssetStr: string, sellAmount?: string) {
    const sellAsset = this.parseAssetString(sellAssetStr);
    
    // In a real implementation, we would fetch supported buy assets from a config or database.
    // For this demonstration, we'll use a hardcoded list of common assets.
    const buyAssetStrings = [
      'stellar:USDC:GBBD67IF633ZHJ2CCYBT6SF67ZALBQZ7O3Z7X6YXRB6Z3Z7X6YXRB6Z3', // Mock USDC
      'stellar:EURC:GDI5S6Y6VXRB6Z3Z7X6YXRB6Z3Z7X6YXRB6Z3Z7X6YXRB6Z3Z7X6Y', // Mock EURC
      'stellar:native'
    ];

    const prices = [];

    for (const buyAssetStr of buyAssetStrings) {
      if (buyAssetStr === sellAssetStr) continue;
      
      try {
        const buyAsset = this.parseAssetString(buyAssetStr);
        const price = await this.calculatePrice(sellAsset, buyAsset, sellAmount as string, 'sell');
        if (price) {
          prices.push({
            asset: buyAssetStr,
            price: price.price
          });
        }
      } catch (error) {
        this.logger.warn(`Failed to fetch price for ${sellAssetStr} -> ${buyAssetStr}: ${(error as any).message}`);
      }
    }

    return { buy_assets: prices };
  }

  /**
   * GET /price
   */
  async getPrice(params: { sell_asset: string; buy_asset: string; sell_amount?: string; buy_amount?: string }) {
    const sellAsset = this.parseAssetString(params.sell_asset);
    const buyAsset = this.parseAssetString(params.buy_asset);
    
    const amount = params.sell_amount || params.buy_amount;
    const type = params.sell_amount ? 'sell' : 'buy';

    if (!amount) {
      throw new Error('Either sell_amount or buy_amount must be provided');
    }

    return await this.calculatePrice(sellAsset, buyAsset, amount, type);
  }

  /**
   * POST /quote
   */
  async createQuote(dto: CreateQuoteDto) {
    const sellAsset = this.parseAssetString(dto.sell_asset);
    const buyAsset = this.parseAssetString(dto.buy_asset);
    
    const amount = dto.sell_amount || dto.buy_amount;
    const type = dto.sell_amount ? 'sell' : 'buy';

    if (!amount) {
      throw new Error('Either sell_amount or buy_amount must be provided');
    }

    const priceInfo = await this.calculatePrice(sellAsset, buyAsset, amount, type);
    
    const quoteId = uuidv4();
    const expiresAt = new Date(Date.now() + 60 * 1000).toISOString(); // 60 seconds TTL

    const quote = {
      id: quoteId,
      sell_asset: dto.sell_asset,
      buy_asset: dto.buy_asset,
      sell_amount: priceInfo.sell_amount,
      buy_amount: priceInfo.buy_amount,
      price: priceInfo.price,
      expires_at: expiresAt,
      context: dto.context
    };

    // Store in Redis with 60s TTL
    await this.redisService.set(`sep38:quote:${quoteId}`, quote, 60);

    return quote;
  }

  /**
   * GET /quote/:id
   */
  async getQuote(id: string) {
    const quote = await this.redisService.get(`sep38:quote:${id}`);
    if (!quote) {
      return null;
    }
    return quote;
  }

  /**
   * Calculates the price between two assets using Stellar DEX pathfinding.
   */
  private async calculatePrice(sellAsset: Asset, buyAsset: Asset, amount: string, type: 'sell' | 'buy') {
    try {
      let result;
      if (type === 'sell') {
        // Find how much buyAsset we get for fixed sellAmount
        const paths = await this.horizonServer.strictSendPaths(sellAsset, amount, [buyAsset]).call();
        if (paths.records.length === 0) {
          throw new Error('No path found');
        }
        result = paths.records[0];
        return {
          price: (parseFloat(result.destination_amount) / parseFloat(amount)).toString(),
          sell_amount: amount,
          buy_amount: result.destination_amount
        };
      } else {
        // Find how much sellAsset we need for fixed buyAmount
        const paths = await this.horizonServer.strictReceivePaths([sellAsset], buyAsset, amount).call();
        if (paths.records.length === 0) {
          throw new Error('No path found');
        }
        result = paths.records[0];
        return {
          price: (parseFloat(amount) / parseFloat(result.source_amount)).toString(),
          sell_amount: result.source_amount,
          buy_amount: amount
        };
      }
    } catch (error: any) {
      this.logger.error(`Pathfinding error: ${error.message}`);
      throw new Error(`Failed to calculate price: ${error.message}`);
    }
  }
}
