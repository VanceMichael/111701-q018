import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSourcePage } from '../src/adapter.mjs';
import {
  availabilityAt,
  buildOperationsQueue,
  checkWindow,
  computeAvailability,
} from '../src/availability.mjs';
import { collect, projectAvailability } from '../src/pipeline.mjs';
import { RecordStore } from '../src/store.mjs';

const DEVICE = '18-A';
const BOOKING = {
  id: 'BK-1',
  deviceId: DEVICE,
  customer: '客户甲',
  state: 'confirmed',
  revision: 1,
  startsAt: '2026-11-20T08:00:00.000Z',
  endsAt: '2026-11-24T08:00:00.000Z',
};
const MAINTENANCE = {
  id: 'MT-1',
  deviceId: DEVICE,
  state: 'scheduled',
  revision: 2,
  startsAt: '2026-11-21T08:00:00.000Z',
  endsAt: '2026-11-23T08:00:00.000Z',
};

function availability(overrides = {}) {
  return computeAvailability({
    deviceId: DEVICE,
    asOf: '2026-11-18T00:00:00.000Z',
    horizon: { startsAt: '2026-11-18T00:00:00.000Z', endsAt: '2026-11-26T00:00:00.000Z' },
    bookings: [BOOKING],
    maintenance: [MAINTENANCE],
    ...overrides,
  });
}

test('来源页可以同时携带设备、维修计划与客户订单', () => {
  const page = normalizeSourcePage({
    source: 'local',
    observedAt: '2026-11-17T08:00:00.000Z',
    items: [{ id: DEVICE, label: '设备甲', state: 'active', revision: 1 }],
    maintenance: [MAINTENANCE],
    bookings: [BOOKING],
  });
  assert.equal(page.devices.length, 1);
  assert.equal(page.maintenance[0].kind, 'maintenance');
  assert.equal(page.bookings[0].kind, 'booking');
  assert.equal(page.bookings[0].customer, '客户甲');
});

test('维修临时提前并与已签约订单重叠时，订单不被取消，冲突进入运营', () => {
  const result = availability();
  assert.equal(result.bookings.length, 1);
  assert.equal(result.bookings[0].state, 'confirmed');
  assert.equal(result.hasConflicts, true);
  assert.equal(result.conflicts.length, 1);

  const conflict = result.conflicts[0];
  assert.equal(conflict.maintenanceId, 'MT-1');
  assert.equal(conflict.bookingId, 'BK-1');
  assert.equal(conflict.customer, '客户甲');
  assert.equal(conflict.requiresOperations, true);
  assert.equal(conflict.state, 'pending');
  // 冲突只覆盖真正重叠的区间，而不是整段订单或整段维修。
  assert.equal(conflict.startsAt, '2026-11-21T08:00:00.000Z');
  assert.equal(conflict.endsAt, '2026-11-23T08:00:00.000Z');

  const queue = buildOperationsQueue([result]);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].queue, 'operations');
  assert.equal(queue[0].bookingId, 'BK-1');
});

test('冲突区间之外，订单和维修各自保持原有状态', () => {
  const result = availability();
  // 订单第一天没有冲突，仍是正常占用。
  const dayOne = availabilityAt(result, '2026-11-20T12:00:00.000Z');
  assert.equal(dayOne.available, false);
  assert.equal(dayOne.requiresOperations, false);
  assert.deepEqual(dayOne.blockers.map((block) => block.id), ['BK-1']);

  // 重叠当天需要运营介入。
  const overlapDay = availabilityAt(result, '2026-11-22T12:00:00.000Z');
  assert.equal(overlapDay.available, false);
  assert.equal(overlapDay.requiresOperations, true);

  // 维修已结束、订单还没结束时，只剩正常订单占用，不再需要运营介入。
  const afterMaintenance = availabilityAt(result, '2026-11-23T12:00:00.000Z');
  assert.equal(afterMaintenance.available, false);
  assert.equal(afterMaintenance.requiresOperations, false);
  assert.deepEqual(afterMaintenance.blockers.map((block) => block.kind), ['booking']);
  // 订单也结束后，设备重新可租。
  assert.equal(availabilityAt(result, '2026-11-24T09:00:00.000Z').available, true);
});

test('设备可租空档不会把维修时段或订单时段算进去', () => {
  const result = availability();
  assert.deepEqual(result.free, [
    { startsAt: '2026-11-18T00:00:00.000Z', endsAt: '2026-11-20T08:00:00.000Z' },
    { startsAt: '2026-11-24T08:00:00.000Z', endsAt: '2026-11-26T00:00:00.000Z' },
  ]);
});

test('请求租期撞上冲突时拒绝出租并要求运营处理', () => {
  const result = availability();
  const blocked = checkWindow(result, {
    startsAt: '2026-11-22T10:00:00.000Z',
    endsAt: '2026-11-22T12:00:00.000Z',
  });
  assert.equal(blocked.available, false);
  assert.equal(blocked.requiresOperations, true);
  assert.equal(blocked.conflicts.length, 1);

  const late = checkWindow(result, {
    startsAt: '2026-11-24T09:00:00.000Z',
    endsAt: '2026-11-25T09:00:00.000Z',
  });
  assert.equal(late.available, true);
  assert.equal(late.requiresOperations, false);
});

test('维修撤销后可用性按订单恢复，冲突消失', () => {
  const result = availability({
    maintenance: [
      MAINTENANCE,
      {
        id: 'MT-1',
        deviceId: DEVICE,
        state: 'cancelled',
        revision: 3,
        observedAt: '2026-11-18T06:00:00.000Z',
      },
    ],
  });
  assert.equal(result.hasMaintenance, false);
  assert.equal(result.maintenance.length, 0);
  assert.equal(result.hasConflicts, false);
  assert.equal(result.conflicts.length, 0);
  // 客户订单仍然保留，被占用的日期依旧不可再租。
  assert.equal(availabilityAt(result, '2026-11-22T12:00:00.000Z').available, false);
  assert.equal(availabilityAt(result, '2026-11-22T12:00:00.000Z').requiresOperations, false);
  // 订单结束后设备重新可租。
  assert.equal(availabilityAt(result, '2026-11-24T09:00:00.000Z').available, true);
});

test('制造商门户的撤销事件可以不带时间窗，也能覆盖内部来源的计划', () => {
  const store = new RecordStore();
  store.save({
    kind: 'maintenance',
    source: 'internal',
    id: 'MT-1',
    deviceId: DEVICE,
    state: 'scheduled',
    revision: 2,
    observedAt: '2026-11-17T08:00:00.000Z',
    startsAt: '2026-11-21T08:00:00.000Z',
    endsAt: '2026-11-23T08:00:00.000Z',
  });
  store.save({
    kind: 'maintenance',
    source: 'manufacturer-portal',
    id: 'MT-1',
    deviceId: DEVICE,
    state: 'revoked',
    revision: 2,
    observedAt: '2026-11-18T09:00:00.000Z',
  });
  store.save({ kind: 'booking', source: 'internal', ...BOOKING });

  const [projection] = projectAvailability(store, { asOf: '2026-11-18T12:00:00.000Z' });
  assert.equal(projection.maintenance.length, 0);
  assert.equal(projection.hasConflicts, false);
  assert.equal(projection.state, 'available');
});

test('乱序到达的旧修订不会把已撤销的维修改回生效', () => {
  const result = availability({
    maintenance: [
      { id: 'MT-1', deviceId: DEVICE, state: 'scheduled', revision: 1, startsAt: MAINTENANCE.startsAt, endsAt: MAINTENANCE.endsAt },
      { id: 'MT-1', deviceId: DEVICE, state: 'scheduled', revision: 3, startsAt: MAINTENANCE.startsAt, endsAt: MAINTENANCE.endsAt },
      { id: 'MT-1', deviceId: DEVICE, state: 'cancelled', revision: 4 },
      { id: 'MT-1', deviceId: DEVICE, state: 'scheduled', revision: 2, startsAt: MAINTENANCE.startsAt, endsAt: MAINTENANCE.endsAt },
    ],
  });
  assert.equal(result.maintenance.length, 0);
  assert.equal(result.hasConflicts, false);
});

test('维修计划不会把设备记录的状态改成维修而永久关闭', () => {
  const result = availability({ deviceState: 'active', maintenance: [MAINTENANCE], bookings: [] });
  assert.equal(availabilityAt(result, '2026-11-18T12:00:00.000Z').available, true);
  assert.equal(availabilityAt(result, '2026-11-22T12:00:00.000Z').available, false);
  // 维修窗口结束后自动恢复，不需要额外写回设备状态。
  assert.equal(availabilityAt(result, '2026-11-23T09:00:00.000Z').available, true);
});

test('已退役设备无论如何都不再出租', () => {
  const result = availability({ deviceState: 'retired' });
  assert.equal(result.available, false);
  assert.equal(result.retired, true);
  assert.deepEqual(result.free, []);
  assert.equal(checkWindow(result, {
    startsAt: '2026-11-30T00:00:00.000Z',
    endsAt: '2026-12-01T00:00:00.000Z',
  }).available, false);
});

test('采集会把维修与订单冲突汇总进运营队列', async () => {
  const store = new RecordStore();
  const result = await collect({
    source: async () => ({
      source: 'local',
      observedAt: '2026-11-17T08:00:00.000Z',
      items: [{ id: DEVICE, label: '设备甲', state: 'active', revision: 1 }],
      maintenance: [MAINTENANCE],
      bookings: [BOOKING],
    }),
    store,
    asOf: '2026-11-18T00:00:00.000Z',
  });

  assert.equal(result.records.length, 1);
  assert.equal(result.maintenance.length, 1);
  assert.equal(result.bookings.length, 1);
  assert.equal(result.operations.length, 1);
  assert.equal(result.operations[0].bookingId, 'BK-1');
  assert.equal(result.availabilities[0].hasConflicts, true);
  // 设备本体仍是 active，没有被维修状态覆盖。
  assert.equal(result.records[0].state, 'active');
  assert.equal(store.list('device')[0].state, 'active');
});

test('门户撤销只带单号时，采集按已有记录补齐设备并恢复可用性', async () => {
  const store = new RecordStore();
  await collect({
    source: async () => ({
      source: 'internal',
      observedAt: '2026-11-17T08:00:00.000Z',
      items: [{ id: DEVICE, label: '设备甲', state: 'active', revision: 1 }],
      maintenance: [MAINTENANCE],
      bookings: [BOOKING],
    }),
    store,
    asOf: '2026-11-18T00:00:00.000Z',
  });

  const result = await collect({
    source: async () => ({
      source: 'manufacturer-portal',
      observedAt: '2026-11-18T09:00:00.000Z',
      items: [],
      // 撤销消息只有单号与状态，没有 deviceId，也没有时间窗。
      maintenance: [{ id: 'MT-1', state: 'revoked' }],
    }),
    store,
    asOf: '2026-11-18T12:00:00.000Z',
  });

  assert.equal(result.maintenance.length, 1);
  assert.equal(result.maintenance[0].deviceId, DEVICE);
  assert.equal(result.availabilities[0].hasMaintenance, false);
  assert.equal(result.availabilities[0].hasConflicts, false);
  assert.equal(result.operations.length, 0);
  // 订单仍在，之后被占用的日期依旧不可再租。
  assert.equal(availabilityAt(result.availabilities[0], '2026-11-22T12:00:00.000Z').available, false);
  assert.equal(availabilityAt(result.availabilities[0], '2026-11-24T09:00:00.000Z').available, true);
});

test('采集顺序无关：先有订单后到维修计划，结果一致', async () => {
  const store = new RecordStore();
  await collect({
    source: async () => ({
      source: 'local',
      observedAt: '2026-11-17T08:00:00.000Z',
      items: [{ id: DEVICE, label: '设备甲', state: 'active', revision: 1 }],
      bookings: [BOOKING],
    }),
    store,
    asOf: '2026-11-18T00:00:00.000Z',
  });
  const before = projectAvailability(store, { asOf: '2026-11-18T00:00:00.000Z' })[0];
  assert.equal(before.hasConflicts, false);

  const result = await collect({
    source: async () => ({
      source: 'local',
      observedAt: '2026-11-17T09:00:00.000Z',
      items: [],
      maintenance: [MAINTENANCE],
    }),
    store,
    asOf: '2026-11-18T00:00:00.000Z',
  });
  assert.equal(result.operations.length, 1);
  assert.equal(result.bookings.length, 0);
  assert.equal(store.list('booking').length, 1);
});

test('首尾相接的档期不算重叠', () => {
  const result = computeAvailability({
    deviceId: DEVICE,
    asOf: '2026-11-18T00:00:00.000Z',
    bookings: [
      { id: 'BK-1', deviceId: DEVICE, state: 'confirmed', startsAt: '2026-11-20T08:00:00.000Z', endsAt: '2026-11-21T08:00:00.000Z' },
      { id: 'BK-2', deviceId: DEVICE, state: 'confirmed', startsAt: '2026-11-21T08:00:00.000Z', endsAt: '2026-11-22T08:00:00.000Z' },
    ],
    maintenance: [
      { id: 'MT-1', deviceId: DEVICE, state: 'scheduled', startsAt: '2026-11-22T08:00:00.000Z', endsAt: '2026-11-23T08:00:00.000Z' },
    ],
  });
  assert.equal(result.conflicts.length, 0);
  assert.equal(availabilityAt(result, '2026-11-21T08:00:00.000Z').blockers[0].id, 'BK-2');
});

test('同一订单的多条重叠维修计划各生成一条运营冲突', () => {
  const result = availability({
    maintenance: [
      MAINTENANCE,
      { id: 'MT-2', deviceId: DEVICE, state: 'scheduled', revision: 1, startsAt: '2026-11-23T00:00:00.000Z', endsAt: '2026-11-23T12:00:00.000Z' },
    ],
  });
  assert.equal(result.conflicts.length, 2);
  assert.deepEqual(
    result.conflicts.map((conflict) => [conflict.maintenanceId, conflict.startsAt, conflict.endsAt]),
    [
      ['MT-1', '2026-11-21T08:00:00.000Z', '2026-11-23T08:00:00.000Z'],
      ['MT-2', '2026-11-23T00:00:00.000Z', '2026-11-23T12:00:00.000Z'],
    ],
  );
  assert.deepEqual(buildOperationsQueue([result]).map((item) => item.maintenanceId), ['MT-1', 'MT-2']);
});

test('已取消的客户订单不再阻挡出租，也不再产生冲突', () => {
  const result = availability({
    bookings: [
      BOOKING,
      { id: 'BK-1', deviceId: DEVICE, state: 'cancelled', revision: 2 },
    ],
  });
  assert.equal(result.bookings.length, 0);
  assert.equal(result.conflicts.length, 0);
  assert.equal(availabilityAt(result, '2026-11-22T12:00:00.000Z').requiresOperations, false);
  assert.deepEqual(availabilityAt(result, '2026-11-22T12:00:00.000Z').blockers.map((b) => b.kind), ['maintenance']);
});

test('时间窗方向错误会被拒绝', () => {
  assert.throws(
    () => computeAvailability({
      deviceId: DEVICE,
      maintenance: [{ id: 'MT-1', deviceId: DEVICE, state: 'scheduled', startsAt: '2026-11-23T08:00:00.000Z', endsAt: '2026-11-21T08:00:00.000Z' }],
    }),
    RangeError,
  );
  assert.throws(
    () => computeAvailability({ deviceId: DEVICE, maintenance: [{ id: 'MT-1', deviceId: DEVICE, state: 'scheduled' }] }),
    TypeError,
  );
});

test('设备记录缺少 deviceId 的维修计划会被拒绝', () => {
  assert.throws(
    () => computeAvailability({
      deviceId: DEVICE,
      maintenance: [{ id: 'MT-1', state: 'scheduled', startsAt: '2026-11-21T08:00:00.000Z', endsAt: '2026-11-23T08:00:00.000Z' }],
    }),
    TypeError,
  );
});

test('合成来源数据体现维修提前并与订单重叠', async () => {
  const result = await collect({ asOf: '2026-11-18T00:00:00.000Z' });
  assert.equal(result.records.length, 2);
  assert.equal(result.bookings.length, 1);
  assert.equal(result.maintenance.length, 1);
  assert.equal(result.operations.length, 1);
  assert.equal(result.operations[0].deviceId, '18-A');
  assert.equal(result.operations[0].customer, '客户甲');
});

test('维修计划临时提前时，旧修订的档期被替换而不是叠加', () => {
  const original = {
    id: 'MT-1',
    deviceId: DEVICE,
    state: 'scheduled',
    revision: 1,
    observedAt: '2026-11-16T08:00:00.000Z',
    startsAt: '2026-11-25T08:00:00.000Z',
    endsAt: '2026-11-27T08:00:00.000Z',
  };
  const movedEarlier = {
    id: 'MT-1',
    deviceId: DEVICE,
    state: 'scheduled',
    revision: 2,
    observedAt: '2026-11-17T08:00:00.000Z',
    startsAt: '2026-11-21T08:00:00.000Z',
    endsAt: '2026-11-23T08:00:00.000Z',
  };

  const before = availability({ maintenance: [original] });
  assert.equal(before.hasConflicts, false);
  assert.deepEqual(
    before.free.map((window) => [window.startsAt, window.endsAt]),
    [
      ['2026-11-18T00:00:00.000Z', '2026-11-20T08:00:00.000Z'],
      ['2026-11-24T08:00:00.000Z', '2026-11-25T08:00:00.000Z'],
    ],
  );

  // 无论新旧修订的到达顺序如何，只看修订号最大的那条。
  for (const plans of [[original, movedEarlier], [movedEarlier, original]]) {
    const after = availability({ maintenance: plans });
    assert.equal(after.maintenance.length, 1);
    assert.equal(after.maintenance[0].revision, 2);
    assert.equal(after.maintenance[0].startsAt, '2026-11-21T08:00:00.000Z');
    assert.equal(after.hasConflicts, true);
    assert.equal(after.conflicts.length, 1);
    assert.equal(after.conflicts[0].bookingId, 'BK-1');
  }
});
