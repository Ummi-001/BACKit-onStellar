import { ActivityService, VELOCITY_MAX_PER_WINDOW } from './activity.service';
import { Activity, ActivityType } from './entities/activity.entity';

function makeActivity(overrides: Partial<Activity> = {}): Activity {
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    userAddress: overrides.userAddress ?? 'GUSER',
    type: overrides.type ?? ActivityType.STAKE_PLACED,
    metadata: overrides.metadata ?? {},
    createdAt: overrides.createdAt ?? new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as Activity;
}

describe('ActivityService', () => {
  let service: ActivityService;
  const repo = {
    create: jest.fn((x) => x),
    save: jest.fn((x) => Promise.resolve({ id: 'saved', ...x })),
    findAndCount: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ActivityService(repo as any);
  });

  describe('checkVelocity()', () => {
    it('allows actions up to the per-minute limit', () => {
      const now = Date.now();
      for (let i = 0; i < VELOCITY_MAX_PER_WINDOW; i++) {
        expect(service.checkVelocity('GUSER', now + i).allowed).toBe(true);
      }
    });

    it('throttles once the limit is exceeded', () => {
      const now = Date.now();
      for (let i = 0; i < VELOCITY_MAX_PER_WINDOW; i++) {
        service.checkVelocity('GUSER', now);
      }
      const result = service.checkVelocity('GUSER', now);
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBeGreaterThan(0);
    });

    it('frees slots after the window elapses', () => {
      const now = Date.now();
      for (let i = 0; i < VELOCITY_MAX_PER_WINDOW; i++) {
        service.checkVelocity('GUSER', now);
      }
      expect(service.checkVelocity('GUSER', now + 61_000).allowed).toBe(true);
    });
  });

  describe('recordAction()', () => {
    it('persists when under the throttle', async () => {
      const result = await service.recordAction('GUSER', ActivityType.STAKE_PLACED, {
        amount: 5,
      });
      expect(result).not.toBeNull();
      expect(repo.save).toHaveBeenCalledTimes(1);
    });

    it('returns null when throttled', async () => {
      const now = Date.now();
      for (let i = 0; i < VELOCITY_MAX_PER_WINDOW + 1; i++) {
        service.checkVelocity('GUSER', now);
      }
      const result = await service.recordAction('GUSER', ActivityType.STAKE_PLACED);
      expect(result).toBeNull();
      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  describe('aggregateActivities()', () => {
    it('clusters consecutive same-actor events within 60s', () => {
      const items = [
        makeActivity({ id: '1', createdAt: new Date('2026-01-01T00:00:00Z') }),
        makeActivity({ id: '2', createdAt: new Date('2026-01-01T00:00:30Z') }),
        makeActivity({
          id: '3',
          userAddress: 'GOTHER',
          createdAt: new Date('2026-01-01T00:00:40Z'),
        }),
      ];

      const clusters = service.aggregateActivities(items);

      expect(clusters).toHaveLength(2);
      expect(clusters[0].count).toBe(2);
      expect(clusters[1].count).toBe(1);
    });

    it('splits clusters when the gap exceeds 60s', () => {
      const items = [
        makeActivity({ createdAt: new Date('2026-01-01T00:00:00Z') }),
        makeActivity({ createdAt: new Date('2026-01-01T00:05:00Z') }),
      ];
      const clusters = service.aggregateActivities(items);
      expect(clusters).toHaveLength(2);
    });
  });

  describe('getGlobalActivity()', () => {
    it('returns a paginated feed', async () => {
      repo.findAndCount.mockResolvedValue([[makeActivity()], 1]);
      const result = await service.getGlobalActivity(1, 20);
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.data).toHaveLength(1);
    });
  });
});
