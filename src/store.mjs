import { compareRecords, recordKey } from './revision.mjs';

/**
 * 进程内记录目录。
 *
 * 设备、维修计划、客户订单各自保留，互不覆盖：
 * 维修计划写入时不会改动设备记录的 state，客户订单也不会被维修记录挤掉。
 */
export class RecordStore {
  #records = new Map();

  save(record) {
    const key = recordKey(record);
    const previous = this.#records.get(key);
    if (!previous || compareRecords(record, previous) >= 0) {
      this.#records.set(key, structuredClone(record));
    }
    return structuredClone(this.#records.get(key));
  }

  get(kind, source, id) {
    const record = this.#records.get(`${kind}:${source}:${id}`);
    return record ? structuredClone(record) : null;
  }

  list(kind) {
    const records = [...this.#records.values()];
    return records
      .filter((record) => kind == null || recordKey(record).startsWith(`${kind}:`))
      .map((record) => structuredClone(record));
  }
}
