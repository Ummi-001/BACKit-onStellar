import { WebhookService, WEBHOOK_AUTO_DISABLE_THRESHOLD } from './webhook.service';
import { WebhookSubscription, WebhookDeliveryLog } from './webhook.entity';
import { WebhookEventType } from './webhook-event-type.enum';

function makeSub(overrides: Partial<WebhookSubscription> = {}): WebhookSubscription {
  return {
    id: 'sub-1',
    userAddress: 'GADDR1',
    url: 'https://example.com/hook',
    secret: 'supersecretkey1234',
    events: [WebhookEventType.CALL_CREATED],
    isActive: true,
    consecutiveFailures: 0,
    disabledAt: null,
    disabledReason: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

describe('WebhookService - delivery health / auto-disable', () => {
  let service: WebhookService;
  const subRepoMock = {
    create: jest.fn(),
    save: jest.fn(),
    remove: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
  };
  const logRepoMock = {
    create: jest.fn((x) => x),
    save: jest.fn(),
    find: jest.fn(),
    count: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new WebhookService(
      subRepoMock as any,
      logRepoMock as any,
      { add: jest.fn() } as any,
      { post: jest.fn() } as any,
    );
  });

  it('increments consecutiveFailures on a failed delivery', async () => {
    const sub = makeSub({ consecutiveFailures: 3 });
    subRepoMock.findOne.mockResolvedValue(sub);

    await service.recordDeliveryOutcome('sub-1', false);

    expect(sub.consecutiveFailures).toBe(4);
    expect(sub.isActive).toBe(true);
    expect(subRepoMock.save).toHaveBeenCalledWith(sub);
  });

  it('resets consecutiveFailures on a successful delivery', async () => {
    const sub = makeSub({ consecutiveFailures: 7 });
    subRepoMock.findOne.mockResolvedValue(sub);

    await service.recordDeliveryOutcome('sub-1', true);

    expect(sub.consecutiveFailures).toBe(0);
    expect(subRepoMock.save).toHaveBeenCalledWith(sub);
  });

  it('auto-disables an endpoint after the threshold is reached', async () => {
    const sub = makeSub({
      consecutiveFailures: WEBHOOK_AUTO_DISABLE_THRESHOLD - 1,
    });
    subRepoMock.findOne.mockResolvedValue(sub);

    await service.recordDeliveryOutcome('sub-1', false);

    expect(sub.isActive).toBe(false);
    expect(sub.disabledAt).toBeInstanceOf(Date);
    expect(sub.disabledReason).toContain('consecutive delivery failures');
    expect(subRepoMock.save).toHaveBeenCalledWith(sub);
  });

  it('does not touch the repository when the subscription is missing', async () => {
    subRepoMock.findOne.mockResolvedValue(null);
    await service.recordDeliveryOutcome('missing', false);
    expect(subRepoMock.save).not.toHaveBeenCalled();
  });

  it('records the delivery log and updates health in recordDelivery()', async () => {
    const sub = makeSub({ consecutiveFailures: 0 });
    subRepoMock.findOne.mockResolvedValue(sub);

    await service.recordDelivery(
      'sub-1',
      'call.created',
      '{}',
      false,
      500,
      'boom',
      1,
    );

    expect(logRepoMock.save).toHaveBeenCalledTimes(1);
    expect(sub.consecutiveFailures).toBe(1);
  });
});
