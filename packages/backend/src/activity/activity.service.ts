import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Activity, ActivityType } from './entities/activity.entity';
import { OnEvent } from '@nestjs/event-emitter';

/** Rolling window used by the velocity throttle, in milliseconds. */
export const VELOCITY_WINDOW_MS = 60_000;
/** Maximum recorded actions a single actor may emit per window. */
export const VELOCITY_MAX_PER_WINDOW = 5;
/** Actions by the same actor within this gap are clustered into one card. */
export const CLUSTER_GAP_MS = 60_000;

export interface VelocityResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export interface AggregatedActivity {
  userAddress: string;
  type: ActivityType;
  count: number;
  firstAt: Date;
  lastAt: Date;
  items: Activity[];
}

export interface PaginatedActivity {
  data: Activity[];
  total: number;
  page: number;
  limit: number;
}

@Injectable()
export class ActivityService {
  private readonly logger = new Logger(ActivityService.name);
  /** Per-actor sliding window of action timestamps. */
  private readonly velocityWindows = new Map<string, number[]>();

  constructor(
    @InjectRepository(Activity)
    private readonly activityRepo: Repository<Activity>,
  ) {}

  async createActivity(
    userAddress: string,
    type: ActivityType,
    metadata: Record<string, unknown>,
  ) {
    const activity = this.activityRepo.create({ userAddress, type, metadata });
    return this.activityRepo.save(activity);
  }

  /**
   * Sliding-window velocity check. Returns whether the actor may emit another
   * feed item right now and, if not, how long until a slot frees up.
   */
  checkVelocity(userAddress: string, now = Date.now()): VelocityResult {
    const windowStart = now - VELOCITY_WINDOW_MS;
    const recent = (this.velocityWindows.get(userAddress) ?? []).filter(
      (ts) => ts > windowStart,
    );

    if (recent.length >= VELOCITY_MAX_PER_WINDOW) {
      const oldest = recent[0];
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: oldest + VELOCITY_WINDOW_MS - now,
      };
    }

    recent.push(now);
    this.velocityWindows.set(userAddress, recent);
    return {
      allowed: true,
      remaining: VELOCITY_MAX_PER_WINDOW - recent.length,
      retryAfterMs: 0,
    };
  }

  /**
   * Record an action into the activity stream, applying the velocity throttle
   * so a single actor cannot flood the feed. Returns `null` when throttled.
   */
  async recordAction(
    userAddress: string,
    type: ActivityType,
    metadata: Record<string, unknown> = {},
  ): Promise<Activity | null> {
    const velocity = this.checkVelocity(userAddress);
    if (!velocity.allowed) {
      this.logger.warn(
        `Velocity limit hit for ${userAddress} (${type}); retry in ${velocity.retryAfterMs}ms`,
      );
      return null;
    }
    return this.createActivity(userAddress, type, metadata);
  }

  /**
   * Global, reverse-chronological activity stream with pagination.
   */
  async getGlobalActivity(
    page = 1,
    limit = 20,
  ): Promise<PaginatedActivity> {
    const [data, total] = await this.activityRepo.findAndCount({
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { data, total, page, limit };
  }

  /**
   * Cluster consecutive actions by the same actor and type that occur within
   * {@link CLUSTER_GAP_MS} into a single grouped activity card.
   */
  aggregateActivities(
    items: Activity[],
    gapMs = CLUSTER_GAP_MS,
  ): AggregatedActivity[] {
    const clusters: AggregatedActivity[] = [];

    for (const item of items) {
      const current = clusters[clusters.length - 1];
      const prev = current?.items[current.items.length - 1];
      const withinGap =
        prev &&
        new Date(item.createdAt).getTime() -
          new Date(prev.createdAt).getTime() <=
          gapMs;

      if (
        current &&
        current.userAddress === item.userAddress &&
        current.type === item.type &&
        withinGap
      ) {
        current.items.push(item);
        current.count += 1;
        current.lastAt = item.createdAt;
      } else {
        clusters.push({
          userAddress: item.userAddress,
          type: item.type,
          count: 1,
          firstAt: item.createdAt,
          lastAt: item.createdAt,
          items: [item],
        });
      }
    }

    return clusters;
  }

  async getUserActivity(
    userAddress: string,
    page = 1,
    limit = 20,
    type?: ActivityType,
  ) {
    const query = this.activityRepo
      .createQueryBuilder('activity')
      .where('activity.userAddress = :userAddress', { userAddress })
      .orderBy('activity.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (type) {
      query.andWhere('activity.type = :type', { type });
    }

    const [data, total] = await query.getManyAndCount();
    return { data, total, page, limit };
  }

  @OnEvent('call.created')
  async handleCallCreated(payload: {
    id: string;
    creatorAddress: string;
    title: string;
  }): Promise<void> {
    await this.createActivity(
      payload.creatorAddress,
      ActivityType.CALL_CREATED,
      { callId: payload.id, title: payload.title },
    );
  }

  @OnEvent('stake.created')
  async handleStakePlaced(payload: {
    userAddress: string;
    callId: string;
    amount: number;
  }): Promise<void> {
    await this.createActivity(payload.userAddress, ActivityType.STAKE_PLACED, {
      callId: payload.callId,
      amount: payload.amount,
    });
  }

  @OnEvent('payout.claimed')
  async handlePayoutClaimed(payload: {
    userAddress: string;
    callId: string;
    amount: number;
  }): Promise<void> {
    await this.createActivity(
      payload.userAddress,
      ActivityType.PAYOUT_CLAIMED,
      { callId: payload.callId, amount: payload.amount },
    );
  }

  @OnEvent('user.followed')
  async handleNewFollower(payload: {
    followingAddress: string;
    followerAddress: string;
  }): Promise<void> {
    await this.createActivity(
      payload.followingAddress,
      ActivityType.NEW_FOLLOWER,
      { followerAddress: payload.followerAddress },
    );
  }
}
