import { parseInstant } from './schedule.mjs';

/**
 * 记录修订合并规则。
 *
 * 采集来源、维修计划与客户订单共用同一套身份（source + id）与修订语义：
 * 1. 双方都带 revision 且不同时，修订号大者胜出；
 * 2. 否则比较 observedAt，较晚观察到的记录胜出；
 * 3. 仍无法区分时，后出现的记录胜出。
 *
 * 这样制造商门户推来的撤销事件即使沿用旧修订号，只要观察时间更新，
 * 也能覆盖原计划；而乱序到达的旧修订不会把撤销结果又改回去。
 */

export function hasRevision(record) {
  if (record?.revisionProvided === true) return true;
  if (record?.revisionProvided === false) return false;
  return record?.revision != null && Number.isFinite(Number(record.revision));
}

function revisionOf(record) {
  return Number(record.revision);
}

function observedAtMs(record) {
  if (record?.observedAt == null) return null;
  try {
    return parseInstant(record.observedAt);
  } catch {
    return null;
  }
}

export function compareRecords(left, right) {
  const leftHas = hasRevision(left);
  const rightHas = hasRevision(right);

  if (leftHas && rightHas && revisionOf(left) !== revisionOf(right)) {
    return revisionOf(left) - revisionOf(right);
  }

  const leftObserved = observedAtMs(left);
  const rightObserved = observedAtMs(right);
  if (leftObserved !== rightObserved) {
    if (leftObserved == null) return -1;
    if (rightObserved == null) return 1;
    return leftObserved - rightObserved;
  }

  if (leftHas !== rightHas) {
    // 同一个观察时间下，带修订号的记录比“无修订号事件”更完整。
    return leftHas ? 1 : -1;
  }
  return 0;
}

export function recordKey(record) {
  const kind = record?.kind == null || record.kind === 'device' ? 'device' : String(record.kind);
  return `${kind}:${record?.source ?? ''}:${record?.id}`;
}

/**
 * 业务身份：使用稳定的业务单号，而不是上报来源。
 *
 * 同一张维修单可能先由内部系统创建、后由制造商门户撤销；
 * 两次上报的 source 不同，但说的是同一件事，必须合并成一条记录。
 */
export function businessKey(record) {
  const kind = record?.kind == null || record.kind === 'device' ? 'device' : String(record.kind);
  if (kind === 'device') return recordKey(record);
  const device = record?.deviceId ?? '';
  return `${kind}:${device}:${record?.id}`;
}

/**
 * 同一身份只保留最新一条记录。
 *
 * @param {Array} records
 * @param {(record: object) => string} [keyOf] 自定义合并身份，默认按 source + id
 */
export function mergeLatest(records, keyOf = recordKey) {
  const latest = new Map();
  for (const record of records) {
    const key = keyOf(record);
    const previous = latest.get(key);
    if (!previous || compareRecords(record, previous) >= 0) {
      latest.set(key, record);
    }
  }
  return [...latest.values()];
}
