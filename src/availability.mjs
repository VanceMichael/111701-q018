import { businessKey, mergeLatest } from './revision.mjs';
import {
  intersectWindows,
  normalizeInstant,
  normalizeWindow,
  parseInstant,
  windowSnapshot,
} from './schedule.mjs';

/**
 * 可用性投影。
 *
 * 关键约束：
 * - 客户订单与维修计划是两类独立事实，任何一方都不能“覆盖”另一方。
 * - 维修计划与订单重叠时，订单保持原样，重叠区间进入运营冲突队列等待人工处理。
 * - 设备是否可租由“实际生效的维修窗口 + 实际生效的订单窗口”共同决定，
 *   而不是由设备记录上的 state 一刀切。
 * - 维修撤销（较新修订号或取消状态）只移除维修窗口，可用性随订单重新计算。
 */

const MAINTENANCE_INACTIVE_STATES = new Set([
  'cancelled',
  'canceled',
  'revoked',
  'withdrawn',
  'void',
  'voided',
  'aborted',
  'deleted',
  'removed',
  'rejected',
  'completed',
  'done',
  'finished',
]);

const BOOKING_INACTIVE_STATES = new Set([
  'cancelled',
  'canceled',
  'revoked',
  'withdrawn',
  'void',
  'voided',
  'aborted',
  'deleted',
  'removed',
  'rejected',
  'expired',
  'draft',
]);

/**
 * 设备本体已退出可租范围的状态。
 *
 * 这里刻意不包含 'maintenance' / 'repair'：维修是否占用日历应由带时间窗的
 * 维修计划决定，而不是由设备记录上的一个状态把整台设备永久关掉。
 * 同理也不包含 'booked' —— 占用来自具体订单。
 */
const DEVICE_RETIRED_STATES = new Set([
  'retired',
  'decommissioned',
  'scrapped',
  'sold',
  'lost',
  'written_off',
  'written-off',
  'out_of_service',
  'out-of-service',
]);

function stateKey(value, fallback) {
  const raw = value == null || value === '' ? fallback : value;
  return String(raw).trim().toLowerCase();
}

function optionalText(...values) {
  for (const value of values) {
    if (value != null && String(value).trim() !== '') return String(value).trim();
  }
  return null;
}

function requiredId(input, label) {
  const id = input.id ?? input.planId ?? input.bookingId ?? input.orderId;
  if (id == null || String(id).trim() === '') {
    throw new TypeError(`${label}缺少 id`);
  }
  return String(id).trim();
}

function readDeviceId(input, label) {
  const deviceId =
    input.deviceId ?? input.itemId ?? input.equipmentId ?? input.assetId ?? input.device;
  if (deviceId == null || String(deviceId).trim() === '') {
    throw new TypeError(`${label}缺少 deviceId`);
  }
  return String(deviceId).trim();
}

function readRevision(input, label) {
  if (input.revision == null || input.revision === '') return { revision: 0, provided: false };
  const revision = Number(input.revision);
  if (!Number.isFinite(revision)) {
    throw new TypeError(`${label}的 revision 必须是数字`);
  }
  return { revision, provided: true };
}

function readWindow(input, label, state, inactiveStates) {
  const hasStart = (input.startsAt ?? input.start ?? input.from) != null;
  const hasEnd = (input.endsAt ?? input.end ?? input.to) != null;
  if (!hasStart && !hasEnd) {
    // 制造商门户的撤销消息可以只带 id + state + revision，不重复携带时间窗。
    if (inactiveStates.has(state)) {
      return { startsAt: null, endsAt: null, startMs: null, endMs: null };
    }
    throw new TypeError(`${label}缺少 startsAt 或 endsAt`);
  }
  return normalizeWindow(
    {
      startsAt: input.startsAt ?? input.start ?? input.from,
      endsAt: input.endsAt ?? input.end ?? input.to,
    },
    label,
  );
}

export function normalizeMaintenancePlan(input, context = {}) {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('维修计划必须是对象');
  }
  const id = requiredId(input, '维修计划');
  const label = `维修计划 ${id}`;
  const deviceId = readDeviceId(input, label);
  const state = stateKey(input.state ?? input.status, 'scheduled');
  const window = readWindow(input, label, state, MAINTENANCE_INACTIVE_STATES);
  const revision = readRevision(input, label);
  return {
    kind: 'maintenance',
    id,
    deviceId,
    source: optionalText(input.source, context.source),
    name: optionalText(input.label, input.name, input.title, input.reason, input.description) ?? label,
    state,
    revision: revision.revision,
    revisionProvided: revision.provided,
    observedAt: optionalText(input.observedAt, context.observedAt),
    startsAt: window.startsAt,
    endsAt: window.endsAt,
  };
}

export function normalizeBooking(input, context = {}) {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('客户订单必须是对象');
  }
  const id = requiredId(input, '客户订单');
  const label = `客户订单 ${id}`;
  const deviceId = readDeviceId(input, label);
  const state = stateKey(input.state ?? input.status, 'confirmed');
  const window = readWindow(input, label, state, BOOKING_INACTIVE_STATES);
  const revision = readRevision(input, label);
  return {
    kind: 'booking',
    id,
    deviceId,
    source: optionalText(input.source, context.source),
    name: optionalText(input.label, input.name, input.title, input.description) ?? label,
    customer: optionalText(
      input.customerName,
      input.customer,
      input.customerId,
      input.tenant,
      input.account,
    ),
    state,
    revision: revision.revision,
    revisionProvided: revision.provided,
    observedAt: optionalText(input.observedAt, context.observedAt),
    startsAt: window.startsAt,
    endsAt: window.endsAt,
  };
}

export function isMaintenanceActive(plan) {
  return !MAINTENANCE_INACTIVE_STATES.has(stateKey(plan.state, 'scheduled'));
}

export function isBookingActive(booking) {
  return !BOOKING_INACTIVE_STATES.has(stateKey(booking.state, 'confirmed'));
}

export function isDeviceRetired(device) {
  return DEVICE_RETIRED_STATES.has(stateKey(device?.state, 'active'));
}

function publicPlan(plan) {
  return {
    id: plan.id,
    deviceId: plan.deviceId,
    source: plan.source ?? null,
    name: plan.name,
    state: plan.state,
    revision: plan.revision,
    startsAt: plan.startsAt,
    endsAt: plan.endsAt,
  };
}

function publicBooking(booking) {
  return {
    id: booking.id,
    deviceId: booking.deviceId,
    source: booking.source ?? null,
    name: booking.name,
    customer: booking.customer ?? null,
    state: booking.state,
    revision: booking.revision,
    startsAt: booking.startsAt,
    endsAt: booking.endsAt,
  };
}

function findConflicts(deviceId, plans, bookings) {
  const conflicts = [];
  for (const plan of plans) {
    for (const booking of bookings) {
      const overlap = intersectWindows(plan, booking, '维修与订单重叠');
      if (!overlap) continue;
      conflicts.push({
        id: `conflict:${deviceId}:${plan.id}:${booking.id}:${overlap.startsAt}`,
        type: 'maintenance_booking_overlap',
        reason: '维修计划与既有订单时间重叠',
        deviceId,
        maintenanceId: plan.id,
        bookingId: booking.id,
        customer: booking.customer ?? null,
        startsAt: overlap.startsAt,
        endsAt: overlap.endsAt,
        state: 'pending',
        status: 'pending_operations',
        requiresOperations: true,
        resolution: null,
      });
    }
  }
  conflicts.sort(
    (left, right) =>
      parseInstant(left.startsAt) - parseInstant(right.startsAt) ||
      parseInstant(left.endsAt) - parseInstant(right.endsAt) ||
      left.id.localeCompare(right.id),
  );
  return conflicts;
}

function buildBlocks(plans, bookings, conflicts) {
  const blocks = [
    ...bookings.map((booking) => ({
      kind: 'booking',
      id: booking.id,
      source: booking.source ?? null,
      startsAt: booking.startsAt,
      endsAt: booking.endsAt,
      startMs: parseInstant(booking.startsAt),
      endMs: parseInstant(booking.endsAt),
      customer: booking.customer ?? null,
      state: booking.state,
      revision: booking.revision,
    })),
    ...plans.map((plan) => ({
      kind: 'maintenance',
      id: plan.id,
      source: plan.source ?? null,
      startsAt: plan.startsAt,
      endsAt: plan.endsAt,
      startMs: parseInstant(plan.startsAt),
      endMs: parseInstant(plan.endsAt),
      state: plan.state,
      revision: plan.revision,
    })),
  ];

  for (const block of blocks) {
    block.conflicts = conflicts
      .filter((conflict) =>
        block.kind === 'booking'
          ? conflict.bookingId === block.id
          : conflict.maintenanceId === block.id,
      )
      .map((conflict) => ({
        startMs: parseInstant(conflict.startsAt),
        endMs: parseInstant(conflict.endsAt),
      }))
      .filter((window) => window.startMs < block.endMs && window.endMs > block.startMs);
    block.conflict = block.conflicts.length > 0;
  }

  blocks.sort(
    (left, right) =>
      left.startMs - right.startMs || left.endMs - right.endMs || left.id.localeCompare(right.id),
  );
  return blocks;
}

function blocksAtTime(blocks, instantMs) {
  return blocks.filter((block) => instantMs >= block.startMs && instantMs < block.endMs);
}

function conflictsAtTime(conflicts, instantMs) {
  return conflicts.filter((conflict) => {
    const startMs = parseInstant(conflict.startsAt);
    const endMs = parseInstant(conflict.endsAt);
    return instantMs >= startMs && instantMs < endMs;
  });
}

function publicBlock(block, atMs = null) {
  const conflict =
    block.conflict &&
    (atMs == null ||
      block.conflicts.some(
        (window) => atMs >= window.startMs && atMs < window.endMs,
      ));
  return {
    kind: block.kind,
    id: block.id,
    source: block.source ?? null,
    startsAt: block.startsAt,
    endsAt: block.endsAt,
    state: block.state,
    revision: block.revision,
    ...(block.kind === 'booking' ? { customer: block.customer ?? null } : {}),
    conflict: Boolean(conflict),
  };
}

function stateAtTime(blocks, conflicts, instantMs) {
  if (conflictsAtTime(conflicts, instantMs).length > 0) return 'conflict';
  const active = blocksAtTime(blocks, instantMs);
  if (active.some((block) => block.kind === 'maintenance')) return 'maintenance';
  if (active.some((block) => block.kind === 'booking')) return 'booked';
  return 'available';
}

function computeFree(blocks, startMs, horizon) {
  let endMs;
  if (horizon) {
    endMs = parseInstant(horizon.endsAt, '可用性范围结束时间');
  } else {
    endMs = blocks.reduce((latest, block) => Math.max(latest, block.endMs), startMs);
  }
  if (endMs <= startMs) return [];

  const busy = blocks
    .map((block) => ({
      startMs: Math.max(block.startMs, startMs),
      endMs: Math.min(block.endMs, endMs),
    }))
    .filter((block) => block.startMs < block.endMs)
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);

  const free = [];
  let cursor = startMs;
  for (const interval of busy) {
    if (interval.startMs > cursor) {
      free.push({
        startsAt: new Date(cursor).toISOString(),
        endsAt: new Date(interval.startMs).toISOString(),
      });
    }
    cursor = Math.max(cursor, interval.endMs);
  }
  if (cursor < endMs) {
    free.push({
      startsAt: new Date(cursor).toISOString(),
      endsAt: new Date(endMs).toISOString(),
    });
  }
  return free;
}

/**
 * 计算单台设备在一组维修计划与订单下的可用性。
 *
 * @param {object} input
 * @param {string} input.deviceId
 * @param {Array}  [input.maintenance] 维修计划，允许包含历史修订
 * @param {Array}  [input.bookings]    客户订单，允许包含历史修订
 * @param {string} [input.deviceState] 设备本体状态；仅“退役”类状态会整体关闭可租性
 * @param {string|number|Date} [input.asOf] 判断“当前能否出租”的时刻
 * @param {{startsAt:*, endsAt:*}} [input.horizon] 可租空档的计算范围
 */
export function computeAvailability({
  deviceId,
  maintenance = [],
  bookings = [],
  asOf = new Date(),
  horizon,
  name = null,
  deviceState = 'active',
}) {
  const normalizedDeviceId = String(deviceId);
  const deviceLabel = `设备 ${normalizedDeviceId}`;

  function assertBelongsToDevice(record, kind) {
    if (record.deviceId == null) {
      throw new TypeError(`${kind} ${record.id} 缺少 deviceId`);
    }
    if (String(record.deviceId) !== normalizedDeviceId) {
      throw new TypeError(`${kind} ${record.id} 属于设备 ${record.deviceId}，不能计入 ${deviceLabel}`);
    }
    return record;
  }

  const plans = mergeLatest(
    maintenance.map((plan) => assertBelongsToDevice(normalizeMaintenancePlan(plan), '维修计划')),
    businessKey,
  ).filter(isMaintenanceActive);

  const reservations = mergeLatest(
    bookings.map((booking) => assertBelongsToDevice(normalizeBooking(booking), '客户订单')),
    businessKey,
  ).filter(isBookingActive);

  for (const plan of plans) {
    if (plan.startsAt == null || plan.endsAt == null) {
      throw new TypeError(`生效中的维修计划 ${plan.id} 缺少时间窗`);
    }
  }
  for (const booking of reservations) {
    if (booking.startsAt == null || booking.endsAt == null) {
      throw new TypeError(`生效中的客户订单 ${booking.id} 缺少时间窗`);
    }
  }

  const conflicts = findConflicts(normalizedDeviceId, plans, reservations);
  const blocks = buildBlocks(plans, reservations, conflicts);
  const asOfIso = normalizeInstant(asOf, `${deviceLabel}的判断时刻`);
  const asOfMs = parseInstant(asOfIso);

  let horizonWindow = null;
  if (horizon) {
    horizonWindow = normalizeWindow(horizon, `${deviceLabel}的可用性范围`);
  }
  const freeStartMs = horizonWindow ? horizonWindow.startMs : asOfMs;
  const retired = isDeviceRetired({ state: deviceState });
  const free = retired ? [] : computeFree(blocks, freeStartMs, horizonWindow);

  const state = retired ? 'retired' : stateAtTime(blocks, conflicts, asOfMs);
  const currentBlocks = blocksAtTime(blocks, asOfMs).map((block) => publicBlock(block, asOfMs));
  const currentConflicts = conflictsAtTime(conflicts, asOfMs);
  const available = state === 'available';

  return {
    deviceId: normalizedDeviceId,
    name,
    deviceState: stateKey(deviceState, 'active'),
    asOf: asOfIso,
    available,
    bookable: available,
    state,
    status: state,
    retired,
    hasConflicts: conflicts.length > 0,
    hasMaintenance: plans.length > 0,
    hasBookings: reservations.length > 0,
    maintenance: plans
      .map(publicPlan)
      .sort((left, right) => left.startsAt.localeCompare(right.startsAt) || left.id.localeCompare(right.id)),
    bookings: reservations
      .map(publicBooking)
      .sort((left, right) => left.startsAt.localeCompare(right.startsAt) || left.id.localeCompare(right.id)),
    blocks: blocks.map((block) => publicBlock(block)),
    currentBlocks,
    currentConflicts,
    conflicts,
    free,
  };
}

function conflictWindowsFor(conflicts, block) {
  return conflicts
    .filter((conflict) =>
      block.kind === 'booking'
        ? conflict.bookingId === block.id
        : conflict.maintenanceId === block.id,
    )
    .map((conflict) => ({
      startMs: parseInstant(conflict.startsAt),
      endMs: parseInstant(conflict.endsAt),
    }));
}

/**
 * 判断某一时刻设备是否还能对外出租。
 */
export function availabilityAt(availability, instant = availability.asOf) {
  const atMs = parseInstant(instant, '查询时刻');
  const blockers = availability.blocks
    .filter((block) => atMs >= parseInstant(block.startsAt) && atMs < parseInstant(block.endsAt))
    .map((block) => {
      const conflicting = conflictWindowsFor(availability.conflicts, block).some(
        (window) => atMs >= window.startMs && atMs < window.endMs,
      );
      return { ...block, conflict: conflicting };
    });
  return {
    deviceId: availability.deviceId,
    at: normalizeInstant(atMs, '查询时刻'),
    available: blockers.length === 0 && !availability.retired,
    bookable: blockers.length === 0 && !availability.retired,
    blockers,
    retired: Boolean(availability.retired),
    requiresOperations: blockers.some((block) => block.conflict),
  };
}

/**
 * 判断一段请求租期能否成交，并列出阻挡它的订单 / 维修 / 运营冲突。
 */
export function checkWindow(availability, requestedWindow) {
  const requested = normalizeWindow(requestedWindow, '请求租期');
  const conflicts = availability.conflicts
    .map((conflict) => ({
      ...conflict,
      overlap: intersectWindows(conflict, requested, '请求租期与运营冲突'),
    }))
    .filter((conflict) => conflict.overlap)
    .map((conflict) => ({ ...conflict, overlap: windowSnapshot(conflict.overlap) }));

  const blockers = availability.blocks
    .map((block) => {
      const overlap = intersectWindows(block, requested, '请求租期与占用');
      if (!overlap) return null;
      const conflicting = conflictWindowsFor(availability.conflicts, block).some(
        (window) => window.startMs < overlap.endMs && window.endMs > overlap.startMs,
      );
      return {
        ...block,
        conflict: conflicting,
        overlap: windowSnapshot(overlap),
      };
    })
    .filter(Boolean);

  const available = blockers.length === 0 && !availability.retired;
  return {
    deviceId: availability.deviceId,
    ...windowSnapshot(requested),
    available,
    bookable: available,
    retired: Boolean(availability.retired),
    requiresOperations: conflicts.length > 0,
    blockers,
    conflicts,
  };
}

/**
 * 把多台设备的可用性投影成运营队列。冲突不会被自动裁决，只排队待人工处理。
 */
export function buildOperationsQueue(availabilities) {
  return availabilities.flatMap((availability) =>
    availability.conflicts.map((conflict) => ({
      ...conflict,
      queue: 'operations',
      deviceName: availability.name ?? null,
    })),
  );
}
