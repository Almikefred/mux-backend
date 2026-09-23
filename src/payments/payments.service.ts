import {
  Inject,
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { PaymentDryRunResponseDto } from './dto/payment-dry-run-response.dto';
import { BatchPaymentDto } from './dto/batch-payment.dto';
import { UpdatePaymentDto } from './dto/update-payment.dto';
import { PrismaService } from '../prisma/prisma.service';
import { WalletsService } from '../wallets/wallets.service';
import {
  PAYMENT_LIMITS_PORT,
  PaymentLimitsPort,
} from './ports/payment-limits.port';
import { WalletStatus } from '../wallets/domain/wallet.model';
import { PaymentStatus } from './entities/payment.entity';
import { PaginationDto, PaginatedResponse } from '../common/dto/pagination.dto';
import { PaymentsFilterDto } from './dto/payments-filter.dto';
import { PaymentCreatedEvent } from './events/payment-created.event';
import { PaymentCompletedEvent } from './events/payment-completed.event';
import { PaymentFailedEvent } from './events/payment-failed.event';
import { retryWithBackoff } from '../common/utils/retry';
import { MetricsService } from '../metrics/metrics.service';
import { RequestContextService } from '../common/request-context/request-context.service';
import { PaymentMetricsService } from './payment-metrics.service';
import { StructuredLogger } from '../common/logging/structured-logger';
import { PaymentStatusHistoryService } from './payment-status-history.service';

// Only PENDING payments can be transitioned; terminal states are immutable.
const ALLOWED_TRANSITIONS: Record<string, PaymentStatus[]> = {
  [PaymentStatus.PENDING]: [PaymentStatus.CONFIRMED, PaymentStatus.FAILED],
  [PaymentStatus.CONFIRMED]: [],
  [PaymentStatus.FAILED]: [],
};

// Stable, typed error codes for the payment write path. Clients can branch on
// these without parsing human-readable messages.
export const PaymentErrorCode = {
  IDEMPOTENCY_CONFLICT: 'PAYMENT_IDEMPOTENCY_CONFLICT',
  IDEMPOTENCY_IN_PROGRESS: 'PAYMENT_IDEMPOTENCY_IN_PROGRESS',
  DEPENDENCY_UNAVAILABLE: 'PAYMENT_DEPENDENCY_UNAVAILABLE',
} as const;

export type PaymentErrorCode =
  (typeof PaymentErrorCode)[keyof typeof PaymentErrorCode];

// Prisma unique-constraint violation code.
const PRISMA_UNIQUE_VIOLATION = 'P2002';

@Injectable()
export class PaymentsService {
  private readonly logger = new StructuredLogger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_LIMITS_PORT)
    private readonly paymentLimitsPort: PaymentLimitsPort,
    private readonly walletsService: WalletsService,
    private readonly eventEmitter: EventEmitter2,
    private readonly metrics: MetricsService,
    private readonly requestContext: RequestContextService,
    private readonly paymentMetrics: PaymentMetricsService,
    private readonly configService: ConfigService,
    private readonly statusHistory: PaymentStatusHistoryService,
  ) {}

  /**
   * Validate a payment exactly as creation does, without signing, submitting,
   * persisting a payment, or emitting a domain event.
   */
  async dryRun(
    createPaymentDto: CreatePaymentDto,
  ): Promise<PaymentDryRunResponseDto> {
    await this.validateForCreation(createPaymentDto);

    return {
      dryRun: true,
      valid: true,
      preview: {
        senderWalletId: createPaymentDto.walletId,
        receiverWalletId: createPaymentDto.receiverWalletId,
        fromId: createPaymentDto.fromId,
        toId: createPaymentDto.toId,
        amount: createPaymentDto.amount,
        currency: createPaymentDto.currency,
        ...(createPaymentDto.assetCode
          ? { assetCode: createPaymentDto.assetCode }
          : {}),
        status: PaymentStatus.PENDING,
      },
      checks: {
        senderWallet: 'ACTIVE',
        receiverWallet: 'FOUND',
        paymentLimits: 'PASSED',
      },
    };
  }

  async create(createPaymentDto: CreatePaymentDto) {
    const requestId = this.requestContext.getRequestId();
    const clientVersion = this.requestContext.getClientVersion();
    const start = Date.now();
    const {
      fromId,
      toId,
      amount,
      currency,
      assetCode,
      description,
      idempotencyKey,
    } = createPaymentDto;

    if (idempotencyKey) {
      const existing = await this.prisma.payment.findUnique({
        where: { idempotencyKey },
      });
      if (existing) {
        this.logger.logWithContext('Idempotency hit, returning existing payment', {
          requestId,
          clientVersion,
          entityId: existing.id.toString(),
          entityType: 'payment',
          operation: 'create',
          outcome: 'idempotent',
        });
        this.metrics.incrementPaymentIdempotencyHit();
        this.paymentMetrics.record({
          operation: 'create',
          outcome: 'idempotent',
          durationMs: Date.now() - start,
          currency,
        });
        return existing;
      }
    }

    try {
      await this.validateForCreation(createPaymentDto);

      const payment = await this.prisma.payment.create({
        data: {
          fromId,
          toId,
          amount,
          currency,
          assetCode,
          description,
          userId: fromId,
          status: PaymentStatus.PENDING,
          idempotencyKey: idempotencyKey ?? null,
        },
      });

      this.metrics.incrementPaymentsCreated();
      this.paymentMetrics.record({
        operation: 'create',
        outcome: 'success',
        durationMs: Date.now() - start,
        currency,
      });

      this.eventEmitter.emit(
        'payment.created',
        new PaymentCreatedEvent(
          payment.id,
          payment.amount,
          payment.currency,
          payment.userId,
        ),
      );

      return payment;
    } catch (err) {
      // Concurrent/replayed request raced past the pre-check and lost the
      // unique-constraint race on idempotencyKey. Return the original result
      // so the write path is exactly-once instead of surfacing a 500.
      if (
        idempotencyKey &&
        err?.code === PRISMA_UNIQUE_VIOLATION &&
        this.isIdempotencyKeyViolation(err)
      ) {
        const existing = await this.prisma.payment.findUnique({
          where: { idempotencyKey },
        });
        if (existing) {
          this.logger.logWithContext(
            'Idempotency conflict resolved to existing payment',
            {
              requestId,
              clientVersion,
              entityId: existing.id.toString(),
              entityType: 'payment',
              operation: 'create',
              outcome: 'idempotent',
            },
          );
          this.metrics.incrementPaymentIdempotencyHit();
          this.paymentMetrics.record({
            operation: 'create',
            outcome: 'idempotent',
            durationMs: Date.now() - start,
            currency,
          });
          return existing;
        }
        // The conflicting row is not visible yet (in-flight transaction).
        // Fail closed with a stable, retryable error code.
        this.metrics.incrementPaymentIdempotencyConflict();
        this.paymentMetrics.record({
          operation: 'create',
          outcome: 'conflict',
          durationMs: Date.now() - start,
          currency,
          failureReason: PaymentErrorCode.IDEMPOTENCY_IN_PROGRESS,
        });
        throw new ConflictException({
          code: PaymentErrorCode.IDEMPOTENCY_IN_PROGRESS,
          message:
            'A payment with this idempotency key is already being processed',
          requestId,
        });
      }

      this.paymentMetrics.record({
        operation: 'create',
        outcome: 'failure',
        durationMs: Date.now() - start,
        currency,
        failureReason: err?.constructor?.name ?? 'unknown',
      });
      throw err;
    }
  }

  /**
   * Detect whether a Prisma P2002 violation was caused by the idempotencyKey
   * unique constraint (as opposed to some other unique field).
   */
  private isIdempotencyKeyViolation(err: any): boolean {
    const target = err?.meta?.target;
    if (Array.isArray(target)) {
      return target.includes('idempotencyKey');
    }
    if (typeof target === 'string') {
      return target.includes('idempotencyKey');
    }
    // If the driver did not report the target, treat it as an idempotency
    // conflict only when the message references the key; otherwise let the
    // original error propagate.
    return typeof err?.message === 'string'
      ? err.message.includes('idempotencyKey')
      : false;
  }

  async createBatch(dto: BatchPaymentDto) {
    // The BatchPaymentDto enforces ArrayMinSize(1) via class-validator so this
    // guard is a safety net for callers that bypass the validation pipe.
    if (!dto.payments || dto.payments.length === 0) {
      throw new BadRequestException('payments must not be empty');
    }
    return Promise.all(dto.payments.map((p) => this.create(p)));
  }

  private async validateForCreation(
    createPaymentDto: CreatePaymentDto,
  ): Promise<void> {
    const { walletId, receiverWalletId, fromId, toId, amount } =
      createPaymentDto;
    const senderWallet = await this.wrapDependency(
      () => this.walletsService.findWalletById(walletId),
      'wallets.findWalletById',
    );
    if (senderWallet.status !== WalletStatus.ACTIVE) {
      throw new BadRequestException(
        `Sender wallet is not active (status: ${senderWallet.status})`,
      );
    }

    const blockSelfPayments = this.configService.get<boolean>(
      'BLOCK_SELF_PAYMENTS',
      false,
    );
    if (blockSelfPayments && fromId === toId) {
      throw new BadRequestException('Payments to self are not allowed');
    }

    await this.wrapDependency(
      () => this.walletsService.findWalletById(receiverWalletId),
      'wallets.findWalletById',
    );
    await this.wrapDependency(
      () => this.paymentLimitsPort.checkLimits(walletId, amount),
      'paymentLimits.checkLimits',
    );
  }

  /**
   * Fail closed on writes when a dependency (RPC/DB/Horizon) is unavailable.
   * Retries with backoff, then surfaces a stable, typed error code and the
   * correlation id so callers can retry safely without leaking internals.
   */
  private async wrapDependency<T>(
    fn: () => Promise<T>,
    dependency: string,
  ): Promise<T> {
    try {
      return await retryWithBackoff(fn, 3, 100, this.logger);
    } catch (err) {
      const requestId = this.requestContext.getRequestId();
      this.logger.errorWithContext('Payment dependency unavailable', {
        requestId,
        operation: 'create',
        outcome: 'failure',
        dependency,
        failureReason: err?.constructor?.name ?? 'unknown',
      });
      this.metrics.incrementPaymentDependencyFailure();
      throw new ServiceUnavailableException({
        code: PaymentErrorCode.DEPENDENCY_UNAVAILABLE,
        message: 'Payment dependency unavailable, please retry',
        requestId,
      });
    }
  }

  async findAll(
    pagination: PaginationDto,
    filters: PaymentsFilterDto,
  ): Promise<PaginatedResponse<any>> {
    const skip = (pagination.page - 1) * pagination.limit;

    const where: any = {};
    if (filters.status) {
      where.status = filters.status;
    }

    const [data, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        skip,
        take: pagination.limit,
      }),
      this.prisma.payment.count({ where }),
    ]);

    return {
      data,
      total,
      page: pagination.page,
      limit: pagination.limit,
    };
  }

  findOne(id: string) {
    return this.prisma.payment.findUnique({
      where: { id: parseInt(id, 10) },
    });
  }

  async update(id: string, updatePaymentDto: UpdatePaymentDto) {
    const requestId = this.requestContext.getRequestId();
    const clientVersion = this.requestContext.getClientVersion();
    const paymentId 

/* … truncated 2017 chars — edit only what you need near the top … */
