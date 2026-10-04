import { createLedger, submit, submitConcurrent, retry, release, bumpInput, verifyWindow, addSignoff, canPublish, type WindowInput } from './engine'

let passed = 0
let failed = 0
function assert(cond: boolean, msg: string) {
  if (cond) { passed++; console.log('  ✓', msg) }
  else { failed++; console.error('  ✗', msg) }
}
function eq<T>(a: T, b: T, msg: string) { assert(JSON.stringify(a) === JSON.stringify(b), `${msg}（期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}）`) }

const W44 = 'ST-02|1026|44'
const W45 = 'ST-02|1026|45'
const windows: WindowInput[] = [
  { key: W44, label: 'ST-02 夜间封闭 10/26 22:00–22:30', capacity: 10, reserve: { emergency: 3, transit: 2 } },
  { key: W45, label: 'ST-02 夜间封闭 10/26 22:30–23:00', capacity: 10, reserve: { emergency: 3, transit: 2 } },
]

console.log('1. 建账：急救/公交保留额度先扣，剩余容量正确')
let led = createLedger(windows, 1)
eq(led.ledgers[W44].used, 5, '保底占用 = 急救3 + 公交2')
eq(led.ledgers[W44].sources.map((s) => s.kind), ['急救保留', '公交保留'], '占用来源顺序：急救先、公交后')
assert(!canPublish(led), '初始无会签无核对，通告被拦截')

console.log('2. 施工申请按剩余容量预占')
let r1 = submit(led, { reqNo: 'REQ-001', client: '建设组甲', windowKey: W44, amount: 4, source: '雨污井施工 (ST-02)' })
led = r1.ledger
eq(r1.status, '已预占', 'REQ-001 占剩余 5 中的 4 → 预占')
eq(led.ledgers[W44].used, 9, '已用 5+4=9')

console.log('3. 超额项排队并标明占用来源')
let r2 = submit(led, { reqNo: 'REQ-002', client: '建设组乙', windowKey: W44, amount: 3, source: '管线吊装 (ST-02)' })
led = r2.ledger
eq(r2.status, '排队中', '仅剩 1，需 3 → 排队（顺序提交不判冲突）')
assert(!!r2.reason?.includes('急救保留') && r2.reason!.includes('REQ-001'), '排队原因标明全部占用来源（急救/公交保底+REQ-001）：' + r2.reason)
eq(led.ledgers[W44].used, 9, '排队项不扣额度')

console.log('4. 两人同窗口同时提交：首写生效，后到留冲突')
const batch = submitConcurrent(led, [
  { reqNo: 'REQ-010', client: '施工员A', windowKey: W45, amount: 2, source: '护栏移位 (ST-02)' },
  { reqNo: 'REQ-011', client: '施工员B', windowKey: W45, amount: 2, source: '标线划设 (ST-02)' },
])
led = batch[0].ledger
eq(batch[0].status, '已预占', 'A 首写预占')
eq(batch[1].status, '冲突', 'B 同回合后到记冲突')
assert(!!batch[1].reason && batch[1].reason.includes('REQ-010'), '冲突标明首写来源 REQ-010')
eq(led.ledgers[W45].used, 7, 'B 不扣额度，已用仍为 5+2=7')
assert(led.requests.find((r) => r.reqNo === 'REQ-011')!.blockReason!.includes('施工员A'), '冲突记录标明首写人')

console.log('5. 失败后按原请求号续跑，不重复扣额度；幂等重放')
let dup = submit(led, { reqNo: 'REQ-010', client: '施工员A', windowKey: W45, amount: 2, source: '护栏移位 (ST-02)' })
assert(dup.duplicate === true && dup.ledger === led && dup.status === '已预占', '同号重复提交：幂等回显，账本不变，不重复扣')
let retryB = retry(led, 'REQ-011')
eq(retryB.status, '已预占', '首写预占仍有效但窗口尚余 3 ≥ 2，B 续跑凭原号进入预占（仍不换号）')
eq(retryB.ledger.requests.find((x) => x.reqNo === 'REQ-011')!.reqNo, 'REQ-011', '续跑沿用原请求号')
eq(retryB.ledger.ledgers[W45].used, 9, '续跑后 5+2+2=9，各自只扣一次')
eq(retryB.ledger.ledgers[W45].sources.filter((s) => s.reqNo === 'REQ-010').length, 1, 'REQ-010 始终只有一笔占用')
// 容量已满场景（独立账本）：续跑一笔冲突请求应转排队而不是重复扣
let iso = createLedger([windows[1]], 1)
iso = submit(iso, { reqNo: 'X-1', client: '甲', windowKey: W45, amount: 5, source: '占满 (ST-02)' }).ledger // 5+5=10
let conflictC = submitConcurrent(iso, [
  { reqNo: 'X-2', client: '乙', windowKey: W45, amount: 2, source: '夜间吊装 (ST-02)' },
])[0]
eq(conflictC.status, '冲突', '同回合后到 → 冲突，不扣额度')
let retryC = retry(conflictC.ledger, 'X-2')
eq(retryC.status, '排队中', '窗口已满，X-2 续跑转排队并标明占用来源')
assert(retryC.ledger.ledgers[W45].used === 10, '排队不扣额度')
assert(!!retryC.reason?.includes('X-1'), '排队原因标明首写占用来源')
let released = release(led, 'REQ-010')
eq(released.ledgers[W45].used, 5, 'A 释放后容量回到 5（B 仍为冲突，未扣）')
let retryB2 = retry(released, 'REQ-011')
eq(retryB2.status, '已预占', 'B 凭原请求号 REQ-011 续跑成功（不换号）')
eq(retryB2.ledger.requests.find((x) => x.reqNo === 'REQ-011')!.reqNo, 'REQ-011', '请求号保持不变')
eq(retryB2.ledger.ledgers[W45].used, 7, '续跑成功后只扣一次 2，已用 7')
led = retryB2.ledger

console.log('6. 排队项随容量腾让自动升入预占')
led = release(led, 'REQ-001')
let q = led.requests.find((x) => x.reqNo === 'REQ-002')!
eq(q.status, '已预占', 'REQ-001 释放 4 后，排队的 REQ-002(3) 自动升入预占')
eq(led.ledgers[W44].used, 8, '窗口44：保底5 + REQ-002×3 = 8')
assert(!led.requests.some((x) => x.reqNo === 'REQ-001'), 'REQ-001 已注销')

console.log('7. 时间/绕行变更：指纹+1，预占重算、会签失效、通告作废、核对清零')
led = led === led ? led : led
for (const [unit, author] of [['交警', '郑航'], ['公交', '顾敏'], ['急救', '夏川'], ['建设', '工务']] as const) {
  led = addSignoff(led, { stageId: 'ST-02', unit, author, opinion: '同意' })
}
led = verifyWindow(led, W44, true)
led = verifyWindow(led, W45, true)
let before = led.fingerprint
const N44 = 'ST-02|1027|44'
const N45 = 'ST-02|1027|45'
led = bumpInput(led, {
  stagesChanged: true,
  windows: [
    { key: N44, label: '改期 10/27 22:00–22:30', capacity: 10, reserve: { emergency: 3, transit: 2 } },
    { key: N45, label: '改期 10/27 22:30–23:00', capacity: 10, reserve: { emergency: 3, transit: 2 } },
  ],
  remap: { [W44]: N44, [W45]: N45 },
})
eq(led.fingerprint, before + 1, '指纹 +1')
assert(led.signoffs.every((s) => s.status === '失效'), '会签全部失效')
assert(Object.values(led.ledgers).every((w) => !w.verified), '核对窗口清零')
assert(led.notice.state === 'blocked', '通告草稿作废并回到拦截')
assert(led.requests.every((r) => r.fingerprint === led.fingerprint), '预占按新指纹重算')
assert(led.requests.every((r) => [N44, N45].includes(r.windowKey)), '全部请求按 remap 重挂到改期后窗口')
assert(led.log.some((l) => l.includes('会签失效') && l.includes('核对清零')), '失效动作进入审计流水')

console.log('8. 未核对窗口清零前不出通告（闸门）')
let gate = createLedger([windows[0]], 3)
gate = submit(gate, { reqNo: 'REQ-100', client: '甲', windowKey: W44, amount: 1, source: 'x (ST-01)' }).ledger
assert(!canPublish(gate), '窗口未核对 + 无会签 → 不出通告')
gate = verifyWindow(gate, W44, true)
assert(!canPublish(gate), '已核对但缺会签 → 仍不出通告')
for (const [unit, author] of [['交警', 'a'], ['公交', 'b'], ['急救', 'c'], ['建设', 'd']] as const) {
  gate = addSignoff(gate, { stageId: 'ST-01', unit, author, opinion: 'x' })
}
assert(canPublish(gate), '窗口全部核对且四方会签齐备 → 通告可出具')
assert(gate.notice.state === 'ready' && gate.notice.text.includes('F3'), '通告草稿带当前指纹')
let gateReopened = verifyWindow(gate, W44, false)
assert(!canPublish(gateReopened), '核对撤销后通告立即重新拦截')

console.log('9. 有排队项的窗口不得核对')
let g2 = createLedger([windows[0]], 5)
g2 = submit(g2, { reqNo: 'REQ-200', client: '甲', windowKey: W44, amount: 5, source: 'x (ST-01)' }).ledger // 5+5=10 预占
g2 = submit(g2, { reqNo: 'REQ-201', client: '乙', windowKey: W44, amount: 1, source: 'y (ST-01)' }).ledger // 超额排队
let g2b = verifyWindow(g2, W44, true)
assert(g2b === g2, '窗口存在超额排队项时核对被拒绝（账本不变）')

console.log('10. 绕行变化同样使会签/核对/通告失效')
let g3 = bumpInput(gate, { detoursChanged: true })
assert(g3.fingerprint === gate.fingerprint + 1, '绕行变更也令指纹+1')
assert(!canPublish(g3), '绕行变更后通告失效')
assert(g3.signoffs.every((s) => s.status === '失效'), '绕行变更后会签失效需重签')

console.log(`\n结果：${passed} 通过，${failed} 失败`)
if (failed) throw new Error(`${failed} 项自检失败`)
