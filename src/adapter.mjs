import {
  normalizeBooking,
  normalizeMaintenancePlan,
} from './availability.mjs';

export function normalizePage(page) {
  if (page === null || typeof page !== 'object') {
    throw new TypeError('来源页必须是对象');
  }
  if (!Array.isArray(page.items)) {
    throw new TypeError('来源页缺少 items');
  }
  return page.items.map((item) => {
    if (!item.id || !item.label || !item.state) {
      throw new Error('来源记录缺少 id、label 或 state');
    }
    return {
      kind: 'device',
      source: page.source,
      id: String(item.id),
      name: String(item.label).trim(),
      state: String(item.state),
      revision: Number(item.revision ?? 0),
      observedAt: page.observedAt ?? null,
    };
  });
}

function normalizeList(page, field, normalize, resolveDeviceId) {
  const list = page[field] ?? [];
  if (!Array.isArray(list)) {
    throw new TypeError(`来源页的 ${field} 必须是数组`);
  }
  return list.map((item) => {
    if (item === null || typeof item !== 'object') {
      throw new TypeError(`来源页的 ${field} 条目必须是对象`);
    }
    const hasDevice =
      item.deviceId ?? item.itemId ?? item.equipmentId ?? item.assetId ?? item.device;
    if (hasDevice == null && typeof resolveDeviceId === 'function') {
      // 门户的撤销消息可能只带单号；用已有记录补齐设备身份。
      const inferred = resolveDeviceId(item, field);
      if (inferred != null) {
        return normalize({ ...item, deviceId: inferred }, page);
      }
    }
    return normalize(item, page);
  });
}

/**
 * 来源页除设备记录外，还可以携带维修计划与客户订单。
 *
 * 这两类记录不写进设备的 state，而是各自保留时间窗；
 * 二者的重叠由可用性投影转成运营冲突，不在这里隐式裁决。
 *
 * @param {object} page
 * @param {{resolveDeviceId?: (item: object) => string|null|undefined}} [options]
 */
export function normalizeSourcePage(page, { resolveDeviceId } = {}) {
  if (page === null || typeof page !== 'object') {
    throw new TypeError('来源页必须是对象');
  }
  if (page.items != null && !Array.isArray(page.items)) {
    throw new TypeError('来源页缺少 items');
  }
  return {
    // 制造商门户可能只推维修撤销事件，不带设备快照。
    devices: page.items == null ? [] : normalizePage(page),
    maintenance: normalizeList(page, 'maintenance', normalizeMaintenancePlan, resolveDeviceId),
    bookings: normalizeList(page, 'bookings', normalizeBooking, resolveDeviceId),
  };
}

export { normalizeBooking, normalizeMaintenancePlan };
