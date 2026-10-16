import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Liveness probe - always returns 200, independent of the database.
   */
  @Get('health')
  health() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Readiness probe - returns 200 if database is connected, 503 otherwise.
   */
  @Get('ready')
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;

      return {
        status: 'ready',
        timestamp: new Date().toISOString(),
        database: { connected: true },
      };
    } catch {
      throw new ServiceUnavailableException({
        status: 'not ready',
        timestamp: new Date().toISOString(),
        database: { connected: false },
      });
    }
  }
}
