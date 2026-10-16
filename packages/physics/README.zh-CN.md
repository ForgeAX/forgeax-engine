# 精确物理实体对隔离

`PhysicsWorld.acquirePairIsolation` 是可选能力，当前由 Rapier 3D 实现。调用方须检查能力是否存在；缺少能力时明确拒绝，不能返回没有物理效果的成功凭证。

输入 `{ worldIdentity, entityA, entityB }` 使用当前同步或注册的真实 ECS World 对象，以及包含 generation 的两个完整实体 handle。两个实体必须不同、存活、启用，并在该 World 的后端中拥有启用的身体和已接纳 Collider。索引、业务 bodyId、渲染实体和 native handle 都不能替代这个身份。

成功结果为 `PairIsolationLease`，其 `release()` 返回 `Result<void, PairIsolationError>`。相同实体对的正向和反向 acquire 共享计数，每次返回独立 lease；释放任意一个后其他引用仍有效，最后一个释放后恢复符合作者策略的接触。重复 release 幂等。硬限为 128 个不同 pair、512 个未释放 lease；预算拒绝及其他预检失败不改变旧隔离或作者分组。

隔离覆盖两个身体的全部普通及 derived Collider，包含 sensor，并由同一后端的原生 contact／intersection hooks 和 KCC predicate 执行。地面、其他身体和其他玩家仍按原策略参与碰撞。KCC 始终排除自身全部 Collider 和 sensor；没有主体的普通 raycast 不隐式应用 pair 隔离。`collisionGroups` 和 `solverGroups` 始终归作者所有，acquire／release 不写入或恢复历史分组。

成功 acquire 表示策略已接纳，在下一次 native step 或 KCC 查询生效，不是模拟完成收据。接触缓存刷新在 step 前进行，同时唤醒涉及身体；最后 release 也走同一路径，包含已经预热或睡眠的接触。刷新或原生 step 的部分失败进入既有 `getDerivedRecoveryState() === 'rebuild-required'`，调用方应重建 PhysicsWorld，不能把普通拒绝当成已回滚。

同一身体的 Collider 替换保留 lease；身体删除或重建、实体 generation 退休、World 更换或 detach、PhysicsWorld dispose 自动使旧 lease 失效并回收配额。backend generation 和身体 record 的对象身份共同阻止旧 lease 改变新身体；原生 handle 的槽位复用不构成身份继承。原生 step 和配对 derived admission 内的 acquire／release 返回 `pair-isolation-busy`，应在该操作完成后重试。

本轮碎裂策略由交互层在成功碎裂后释放握持，并复用现有失效／清理路径。Engine 不把旧 pair 隐式复制给碎片；源身体删除是最终清理兜底。失败碎裂保持源身体时，原 lease 保持有效。

真实 CPU／Rapier 回归位于 `physics-rapier3d/src/__tests__/pair-isolation.unit.test.ts`；这些证据不替代 Engine 的浏览器、Dawn 和完整 60 帧 smoke 门禁，也不代表调用方已完成绑定或接入。
