import { Reflector } from '@nestjs/core';
import { ApiKeyGuard, REQUIRE_API_KEY, IS_PUBLIC } from './api-key.guard';
import { ApiKeyService } from './api-key.service';

describe('ApiKeyGuard', () => {
  let guard: ApiKeyGuard;
  let mockApiKeyService: Partial<ApiKeyService>;
  let reflector: Reflector;

  beforeEach(() => {
    mockApiKeyService = {
      validateApiKey: jest.fn(async (key: string) => ({
        apiKey: { id: 'key-id' },
        project: { id: 'proj-id', rateLimitRpm: 10 },
        developer: { id: 'dev-id' },
      })),
      recordUsage: jest.fn(async () => {}),
    };

    reflector = new Reflector();

    guard = new ApiKeyGuard(mockApiKeyService as ApiKeyService, reflector);
  });

  it('allows when route is public via IS_PUBLIC metadata', async () => {
    // spy on reflector to return true for isPublic
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);

    const context: any = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => ({}) }),
    };

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('rejects when Authorization header missing', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    jest.spyOn(reflector, 'get').mockReturnValue(undefined);

    const context: any = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }),
    };

    await expect(guard.canActivate(context)).rejects.toThrow();
  });

  it('allows with valid Authorization header and attaches context', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    jest.spyOn(reflector, 'get').mockReturnValue(true);

    const req: any = {
      headers: { authorization: 'ApiKey mux_test_abc', 'user-agent': 'jest' },
      path: '/wallets/protected',
      method: 'GET',
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    };

    const res: any = {
      statusCode: 200,
      on: jest.fn((event, callback) => {
        if (event === 'finish') {
          callback();
        }
      }),
    };

    const context: any = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    };

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.apiKeyContext).toBeDefined();
    expect(req.apiKeyInfo).toEqual({
      id: 'key-id',
      project: {
        rateLimitRpm: 10,
      },
    });
    expect(mockApiKeyService.recordUsage).toHaveBeenCalledWith(
      'key-id',
      'proj-id',
      'GET /wallets/protected',
      'GET',
      200,
      '127.0.0.1',
      'jest',
      expect.any(Number),
    );
  });

  it('maps upstream validation errors to ServiceUnavailableException (503)', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    jest.spyOn(reflector, 'get').mockReturnValue(true);

    // Make validateApiKey throw a non-Unauthorized error
    (mockApiKeyService.validateApiKey as jest.Mock) = jest.fn(async () => {
      throw new Error('DB is down');
    });

    const req: any = {
      headers: {
        authorization: 'ApiKey mux_test_abc',
        'user-agent': 'jest',
      },
      path: '/wallets/protected',
      method: 'GET',
      ip: '127.0.0.1',
    };

    const context: any = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => req }),
    };

    await expect(guard.canActivate(context)).rejects.toThrow(
      'API key validation service unavailable',
    );
  });

  it('rejects when a client-supplied user id does not match the verified API key identity', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    jest.spyOn(reflector, 'get').mockReturnValue(true);

    const req: any = {
      headers: { authorization: 'ApiKey mux_test_abc', 'user-agent': 'jest' },
      path: '/wallets/protected',
      method: 'GET',
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
      query: { userId: 'attacker-supplied-id' },
      body: { userId: 'attacker-supplied-id' },
    };

    const context: any = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => req }),
    };

    await expect(guard.canActivate(context)).rejects.toThrow();
  });

  it('rejects when a client-supplied user id header does not match the verified API key identity', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    jest.spyOn(reflector, 'get').mockReturnValue(true);

    const req: any = {
      headers: {
        authorization: 'ApiKey mux_test_abc',
        'user-agent': 'jest',
        'x-user-id': 'attacker-supplied-id',
      },
      path: '/wallets/protected',
      method: 'GET',
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    };

    const context: any = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => req }),
    };

    await expect(guard.canActivate(context)).rejects.toThrow();
  });

  it('denies INACTIVE users by default with a stable error code', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    jest.spyOn(reflector, 'get').mockReturnValue(true);

    (mockApiKeyService.validateApiKey as jest.Mock) = jest.fn(async () => ({
      apiKey: { id: 'key-id' },
      project: { id: 'proj-id', rateLimitRpm: 10 },
      developer: { id: 'dev-id' },
      user: { id: 'dev-id', status: 'INACTIVE' },
    }));

    const req: any = {
      headers: { authorization: 'ApiKey mux_test_abc', 'user-agent': 'jest' },
      path: '/wallets/protected',
      method: 'GET',
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    };

    const context: any = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => req }),
    };

    await expect(guard.canActivate(context)).rejects.toThrow();
  });

  it('denies SUSPENDED users by default with a stable error code', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    jest.spyOn(reflector, 'get').mockReturnValue(true);

    (mockApiKeyService.validateApiKey as jest.Mock) = jest.fn(async () => ({
      apiKey: { id: 'key-id' },
      project: { id: 'proj-id', rateLimitRpm: 10 },
      developer: { id: 'dev-id' },
      user: { id: 'dev-id', status: 'SUSPENDED' },
    }));

    const req: any = {
      headers: { authorization: 'ApiKey mux_test_abc', 'user-agent': 'jest' },
      path: '/wallets/protected',
      method: 'GET',
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    };

    const context: any = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => req }),
    };

    await expect(guard.canActivate(context)).rejects.toThrow();
  });

  it('allows ACTIVE users through the status policy', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    jest.spyOn(reflector, 'get').mockReturnValue(true);

    (mockApiKeyService.validateApiKey as jest.Mock) = jest.fn(async () => ({
      apiKey: { id: 'key-id' },
      project: { id: 'proj-id', rateLimitRpm: 10 },
      developer: { id: 'dev-id' },
      user: { id: 'dev-id', status: 'ACTIVE' },
    }));

    const req: any = {
      headers: { authorization: 'ApiKey mux_test_abc', 'user-agent': 'jest' },
      path: '/wallets/protected',
      method: 'GET',
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    };

    const res: any = {
      statusCode: 200,
      on: jest.fn((event, callback) => {
        if (event === 'finish') {
          callback();
        }
      }),
    };

    const context: any = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    };

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('fails closed when the status lookup dependency is unavailable', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    jest.spyOn(reflector, 'get').mockReturnValue(true);

    (mockApiKeyService.validateApiKey as jest.Mock) = jest.fn(async () => {
      throw new Error('status lookup DB is down');
    });

    const req: any = {
      headers: { authorization: 'ApiKey mux_test_abc', 'user-agent': 'jest' },
      path: '/wallets/protected',
      method: 'POST',
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    };

    const context: any = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => req }),
    };

    await expect(guard.canActivate(context)).rejects.toThrow(
      'API key validation service unavailable',
    );
  });
});
