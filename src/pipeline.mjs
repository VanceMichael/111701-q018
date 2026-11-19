import { normalizeSourcePage } from './adapter.mjs';
import { buildOperationsQueue, computeAvailability } from './availability.mjs';
import { readSource } from './source.mjs';
import { RecordStore } from './store.mjs';
import { businessKey, mergeLatest, recordKey } from './revision.mjs';

/**
 * 从目录里的最新记录计算每台设备的可用性。
 *
 * 只看“最新修订且仍然生效”的维修计划与订单；
 * 已撤销的维修不会再从日历上占位，也不会残留冲突。
 *
 * 合并按业务单号（设备 + 单号）而不是上报来源：
 * 制造商门户推来的撤销事件常常来自另一个来源，必须能撤销内部系统创建的计划。
 */
function projectAvailability(store, { asOf, horizon } = {}) {
  const devices = mergeLatest(store.list('device'), recordKey);
  const maintenance = mergeLatest(store.list('maintenance'), businessKey);
  const bookings = mergeLatest(store.list('booking'), businessKey);

  const byDevice = (record) => record.deviceId;
  const deviceIds = new Set([
    ...devices.map((device) => device.id),
    ...maintenance.map(byDevice),
    ...bookings.map(byDevice),
  ]);

  return [...deviceIds]
    .sort((left, right) => String(left).localeCompare(String(right)))
    .map((deviceId) => {
      const device = devices.find((candidate) => candidate.id === String(deviceId));
      return computeAvailability({
        deviceId,
        name: device?.name ?? null,
        deviceState: device?.state ?? 'active',
        maintenance: maintenance.filter((plan) => byDevice(plan) === String(deviceId)),
        bookings: bookings.filter((booking) => byDevice(booking) === String(deviceId)),
        ...(asOf === undefined ? {} : { asOf }),
        ...(horizon === undefined ? {} : { horizon }),
      });
    });
}

export async function collect({ source = readSource, store = new RecordStore(), asOf, horizon } = {}) {
  const page = await source();
  const known = new Map(
    [...store.list('maintenance'), ...store.list('booking')].map((record) => [
      `${record.kind}:${record.id}`,
      record.deviceId ?? null,
    ]),
  );
  const { devices, maintenance, bookings } = normalizeSourcePage(page, {
    // 撤销事件可能只带单号，按“类别 + 单号”回查设备身份。
    resolveDeviceId: (item, field) =>
      known.get(`${field === 'maintenance' ? 'maintenance' : 'booking'}:${item.id}`) ?? undefined,
  });

  const records = devices.map((record) => store.save(record));
  const maintenanceRecords = maintenance.map((record) => store.save(record));
  const bookingRecords = bookings.map((record) => store.save(record));

  const availabilities = projectAvailability(store, { asOf, horizon });
  const operations = buildOperationsQueue(availabilities);

  return {
    source: page.source,
    observedAt: page.observedAt ?? null,
    records,
    maintenance: maintenanceRecords,
    bookings: bookingRecords,
    devices: records,
    availabilities,
    operations,
    store,
  };
}

export { projectAvailability };

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await collect();
  console.log(
    JSON.stringify(
      {
        source: result.source,
        count: result.records.length,
        maintenance: result.maintenance.length,
        bookings: result.bookings.length,
        operations: result.operations.length,
      },
      null,
      2,
    ),
  );
}
