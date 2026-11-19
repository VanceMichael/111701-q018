/**
 * 时间窗工具。
 *
 * 租赁日历统一使用左闭右开区间 [startsAt, endsAt)：
 * 上一段在 10:00 结束、下一段在 10:00 开始时，两段并不重叠。
 */

function readWindowFields(input, label) {
  if (input === null || typeof input !== 'object') {
    throw new TypeError(`${label}必须包含 startsAt 和 endsAt`);
  }
  const startsAt = input.startsAt ?? input.start;
  const endsAt = input.endsAt ?? input.end;
  if (startsAt == null || endsAt == null) {
    throw new TypeError(`${label}缺少 startsAt 或 endsAt`);
  }
  return { startsAt, endsAt };
}

export function parseInstant(value, label = '时间') {
  let milliseconds;
  if (value instanceof Date) {
    milliseconds = value.getTime();
  } else if (typeof value === 'number') {
    milliseconds = value;
  } else if (typeof value === 'string' && value.trim() !== '') {
    milliseconds = Date.parse(value);
  } else {
    throw new TypeError(`${label}必须是有效的 ISO-8601 时间`);
  }
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError(`${label}必须是有效的 ISO-8601 时间`);
  }
  return milliseconds;
}

export function normalizeInstant(value, label = '时间') {
  return new Date(parseInstant(value, label)).toISOString();
}

/**
 * 校验并规整一个时间窗，返回规范化的 ISO 字符串和毫秒值。
 */
export function normalizeWindow(input, label = '时间窗') {
  const fields = readWindowFields(input, label);
  const startMs = parseInstant(fields.startsAt, `${label}的开始时间`);
  const endMs = parseInstant(fields.endsAt, `${label}的结束时间`);
  if (startMs >= endMs) {
    throw new RangeError(`${label}的结束时间必须晚于开始时间`);
  }
  return {
    startsAt: new Date(startMs).toISOString(),
    endsAt: new Date(endMs).toISOString(),
    startMs,
    endMs,
  };
}

/**
 * 求两个时间窗的交集；没有交集时返回 null。
 */
export function intersectWindows(left, right, label = '时间窗') {
  const a = normalizeWindow(left, `${label}（左）`);
  const b = normalizeWindow(right, `${label}（右）`);
  const startMs = Math.max(a.startMs, b.startMs);
  const endMs = Math.min(a.endMs, b.endMs);
  if (startMs >= endMs) return null;
  return {
    startsAt: new Date(startMs).toISOString(),
    endsAt: new Date(endMs).toISOString(),
    startMs,
    endMs,
  };
}

/**
 * 只返回对外可见的时间字段。
 */
export function windowSnapshot(window) {
  return { startsAt: window.startsAt, endsAt: window.endsAt };
}
