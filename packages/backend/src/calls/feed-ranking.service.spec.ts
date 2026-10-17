import { FeedRankingService } from './feed-ranking.service';
import { Call, CallStatus } from './entities/call.entity';

let idCounter = 0;

function makeCall(overrides: Partial<Call> = {}): Call {
  idCounter += 1;
  return {
    id: `call-${idCounter}`,
    title: 'call',
    description: '',
    creatorAddress: 'GCREATOR',
    isHidden: false,
    reportCount: 0,
    status: CallStatus.OPEN,
    endsAt: null,
    resolvedAt: null,
    finalPrice: null,
    totalYesStake: '0',
    totalNoStake: '0',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as Call;
}

describe('FeedRankingService', () => {
  let service: FeedRankingService;
  const now = new Date('2026-01-01T01:00:00Z').getTime();

  beforeEach(() => {
    service = new FeedRankingService();
  });

  it('ranks higher-staked calls above lower-staked ones', () => {
    const low = makeCall({ totalYesStake: '10' });
    const high = makeCall({ totalYesStake: '100000' });

    const ranked = service.rankCalls([low, high], { now });

    expect(ranked[0].call.id).toBe(high.id);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it('uses creator reputation to break ties', () => {
    const trusted = makeCall({ creatorAddress: 'GTRUSTED' });
    const unknown = makeCall({ creatorAddress: 'GUNKNOWN' });

    const ranked = service.rankCalls([unknown, trusted], {
      now,
      reputation: { GTRUSTED: 1 },
    });

    expect(ranked[0].call.id).toBe(trusted.id);
  });

  it('applies viewer affinity when provided', () => {
    const favourite = makeCall({ creatorAddress: 'GFAV' });
    const other = makeCall({ creatorAddress: 'GOTHER' });

    const ranked = service.rankCalls([other, favourite], {
      now,
      viewerAddress: 'GVIEWER',
      affinity: { GFAV: 1 },
    });

    expect(ranked[0].call.id).toBe(favourite.id);
  });

  it('decays older calls so fresh ones can overtake them', () => {
    const fresh = makeCall({
      totalYesStake: '100',
      createdAt: new Date('2026-01-01T00:30:00Z'),
    });
    const stale = makeCall({
      totalYesStake: '100',
      createdAt: new Date('2025-12-20T00:00:00Z'),
    });

    const [freshRanked, staleRanked] = service.rankCalls([fresh, stale], {
      now,
    });

    expect(freshRanked.call.id).toBe(fresh.id);
    expect(freshRanked.score).toBeGreaterThan(staleRanked.score);
  });

  it('boosts OPEN calls and demotes RESOLVED ones', () => {
    const open = makeCall({ status: CallStatus.OPEN });
    const resolved = makeCall({
      status: CallStatus.RESOLVED_YES,
      totalYesStake: '100',
    });

    const ranked = service.rankCalls([resolved, open], { now });
    expect(ranked[0].call.id).toBe(open.id);
  });

  it('paginates a ranked feed through getRankedFeed()', async () => {
    const calls = [
      makeCall({ totalYesStake: '1000' }),
      makeCall({ totalYesStake: '100' }),
      makeCall({ totalYesStake: '10' }),
    ];
    const source = {
      findFeed: jest.fn().mockResolvedValue([calls, calls.length]),
    };

    const page = await service.getRankedFeed(source, 1, 2, { now });

    expect(source.findFeed).toHaveBeenCalledWith(1, 2);
    expect(page.data).toHaveLength(2);
    expect(page.total).toBe(3);
  });
});
