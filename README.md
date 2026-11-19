# 设备租赁日历采集服务

这是一个用于设备租赁日历的本地数据采集与归档服务。当前版本从仓库自带的合成来源记录读取一页数据，经过字段规整后写入进程内目录；来源内容和规整后的记录保留独立边界，便于在不访问外部系统的情况下复现采集过程。

## 运行

需要 Node.js 20 或更高版本，不需要安装第三方依赖。

```sh
npm test
npm run build
node src/pipeline.mjs
```

测试使用项目内的合成记录；执行不需要网络、凭据或外部服务。

## 设备可用性

来源页除设备记录（`items`）外，还可以携带两类独立记录：

- `maintenance`：维修计划，带 `startsAt` / `endsAt` 时间窗；
- `bookings`：已签约的客户订单，带 `startsAt` / `endsAt` 时间窗。

维修撤销事件可以只带单号与状态（由制造商门户推送时常见），此时 `items` 可以省略，
设备身份会按单号从已有记录补齐。

采集结果中的 `availabilities` 会为每台设备给出一份可用性投影，`operations` 则汇总需要人工处理的冲突。

设计原则：

1. **设备状态不再一刀切。** 维修计划不会把设备记录的 `state` 改成维修。只有设备本体的退役类状态
   （`retired`、`decommissioned`、`sold` 等）才会整体关闭可租性；维修占用由带时间窗的计划表达，
   计划结束后设备自动恢复可租。
2. **订单不会被静默取消。** 维修计划与既有订单重叠时，订单原样保留，重叠区间同时记入
   `conflicts`，状态为 `pending_operations`，等待运营决定改期、换机还是补偿客户。
   设备在该区间内不可再出租（`available: false`），但这不等于替客户取消了订单。
3. **冲突只覆盖真正重叠的区间。** 一段五天订单与两天维修重叠时，只有那两天标记为冲突，
   其余日期仍按正常占用处理。
4. **撤销维修会恢复正确可用性。** 较新的 `revision`（或较新的 `observedAt`）的 `cancelled` /
   `revoked` / `withdrawn` 等状态会移除维修窗口，冲突随之消失，日历按订单重新计算。
   撤销事件可以不重复携带时间窗，也可以来自与创建时不同的来源（按“设备 + 单号”合并）。
5. **乱序到达不会回滚。** 合并只保留最新修订；旧修订迟到时不会把已撤销的维修重新启用。

### 查询接口

```js
import { collect, projectAvailability } from './src/pipeline.mjs';
import { availabilityAt, checkWindow, buildOperationsQueue } from './src/availability.mjs';

const result = await collect({ asOf: '2026-11-18T00:00:00.000Z' });
const device = result.availabilities[0];

availabilityAt(device, '2026-11-22T12:00:00.000Z'); // 某时刻能否出租，是否需要运营
checkWindow(device, { startsAt: '…', endsAt: '…' }); // 某段租期能否成交
buildOperationsQueue(result.availabilities); // 待运营处理的冲突队列
```

时间窗统一为左闭右开区间 `[startsAt, endsAt)`：上一段在 10:00 结束、下一段在 10:00 开始时不算重叠。
