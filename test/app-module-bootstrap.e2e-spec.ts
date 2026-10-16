import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Boots the full application module graph and asserts the public HTTP surface
 * is wired exactly as documented. Guards against duplicate route registrations
 * (e.g. a maintenance handler living in both the health and maintenance
 * controllers) and against fail-open behaviour when persisted state is
 * unreadable.
 */
describe('AppModule bootstrap (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue({
        $connect: jest.fn().mockResolvedValue(undefined),
        $disconnect: jest.fn().mockResolvedValue(undefined),
        maintenanceState: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('registers GET /v1/maintenance exactly once', () => {
    const server = app.getHttpServer();
    const router = server?._events?.request?._router ?? server?._events?.request;
    const stack: Array<{ route?: { path?: string; methods?: Record<string, boolean> } }> =
      router?.stack ?? [];

    const maintenanceRoutes = stack.filter(
      (layer) =>
        layer?.route?.path === '/v1/maintenance' &&
        layer?.route?.methods?.get === true,
    );

    expect(maintenanceRoutes).toHaveLength(1);
  });

  it('fails closed with 503 when the maintenance state read rejects', async () => {
    const prisma = app.get(PrismaService);
    (prisma.maintenanceState.findFirst as jest.Mock).mockRejectedValueOnce(
      new Error('database unavailable'),
    );

    const response = await request(app.getHttpServer()).get('/v1/maintenance');

    expect(response.status).toBe(503);
    expect(response.body).not.toEqual(
      expect.objectContaining({ enabled: false }),
    );
  });
});
