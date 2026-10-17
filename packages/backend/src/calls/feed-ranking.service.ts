import { Injectable, Logger } from '@nestjs/common';
import { Call, CallStatus } from './entities/call.entity';

/**
 * Context used to personalise a feed ranking. All maps are optional so the
 * engine degrades gracefully to a pure popularity + recency ranking.
 */
export interface RankContext {
  /** Viewer wallet address (undefined → anonymous/global feed). */
  viewerAddress?: string;
  /** Creator address → reputation score in the [0, 1] range. */
  reputation?: Record<string, number>;
  /** Creator address → affinity score in the [0, 1] range for this viewer. */
  affinity?: Record<string, number>;
  /** Injectable clock for deterministic tests. */
  now?: number;
  /** Relative weights of the composite score. */
  weights?: Partial<RankWeights>;
  /** Gravity exponent controlling time decay. */
  gravity?: number;
}

export interface RankWeights {
  volume: number;
  reputation: number;
  affinity: number;
}

export interface RankedCall {
  call: Call;
  score: number;
  components: {
    volume: number;
    reputation: number;
    affinity: number;
    ageHours: number;
  };
}

const DEFAULT_WEIGHTS: RankWeights = {
  volume: 0.5,
  reputation: 0.3,
  affinity: 0.2,
};

const DEFAULT_GRAVITY = 1.2;
/** Larger values slow the time decay of older calls. */
const DECAY_OFFSET_HOURS = 2;

@Injectable()
export class FeedRankingService {
  private readonly logger = new Logger(FeedRankingService.name);

  /**
   * Compute the composite score for a single call:
   *
   *   score = ( wv·log10(1+volume) + wr·reputation + wa·affinity )
   *           / (ageHours + OFFSET) ^ gravity
   */
  scoreCall(call: Call, ctx: RankContext = {}): RankedCall {
    const weights: RankWeights = { ...DEFAULT_WEIGHTS, ...(ctx.weights ?? {}) };
    const gravity = ctx.gravity ?? DEFAULT_GRAVITY;
    const now = ctx.now ?? Date.now();

    const volumeScore = Math.log10(1 + this.stakeVolume(call));
    const reputation = this.clamp01(ctx.reputation?.[call.creatorAddress] ?? 0);
    const affinity = this.clamp01(ctx.affinity?.[call.creatorAddress] ?? 0);
    const ageHours = Math.max(
      0,
      (now - new Date(call.createdAt).getTime()) / 3_600_000,
    );

    const numerator =
      weights.volume * volumeScore +
      weights.reputation * reputation +
      weights.affinity * affinity;
    const score = numerator / Math.pow(ageHours + DECAY_OFFSET_HOURS, gravity);

    return {
      call,
      score,
      components: { volume: volumeScore, reputation, affinity, ageHours },
    };
  }

  /**
   * Rank calls, highest score first. Open calls receive a small boost while
   * hidden and resolved calls are demoted.
   */
  rankCalls(calls: Call[], ctx: RankContext = {}): RankedCall[] {
    return calls
      .map((call) => {
        const ranked = this.scoreCall(call, ctx);
        if (call.status === CallStatus.OPEN) {
          ranked.score *= 1.1;
        } else if (
          call.status === CallStatus.RESOLVED_YES ||
          call.status === CallStatus.RESOLVED_NO
        ) {
          ranked.score *= 0.5;
        }
        return ranked;
      })
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Fetch a page of calls from a {@link CallsRepository}-like source and
   * return it ranked. Over-fetches `page * limit` rows so the global ranking is
   * applied before pagination.
   */
  async getRankedFeed(
    source: {
      findFeed(page: number, limit: number): Promise<[Call[], number]>;
    },
    page = 1,
    limit = 20,
    ctx: RankContext = {},
  ): Promise<{ data: RankedCall[]; total: number; page: number; limit: number }> {
    const safePage = Math.max(1, page);
    const safeLimit = Math.max(1, limit);
    const fetchSize = Math.min(safePage * safeLimit, 500);

    const [calls, total] = await source.findFeed(1, fetchSize);
    const ranked = this.rankCalls(calls, ctx);
    const start = (safePage - 1) * safeLimit;

    this.logger.debug(
      `Ranked ${ranked.length} calls for page ${safePage} (limit ${safeLimit})`,
    );

    return {
      data: ranked.slice(start, start + safeLimit),
      total,
      page: safePage,
      limit: safeLimit,
    };
  }

  private stakeVolume(call: Call): number {
    const yes = Number(call.totalYesStake ?? 0) || 0;
    const no = Number(call.totalNoStake ?? 0) || 0;
    return yes + no;
  }

  private clamp01(value: number): number {
    if (Number.isNaN(value) || !Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(0, value));
  }
}
