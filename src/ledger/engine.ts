// 通行账引擎：纯函数、无 UI 依赖，可单测。
// 账本对象不可变更新 —— 每个动作返回新的 Ledger，便于留痕与回放。

export type AgencyUnit = '交警' | '公交' | '急救' | '建设'
export type RequestStatus = '已预占' | '排队中' | '冲突'
export type SourceKind = '急救保留' | '公交保留' | '施工预占'

export interface ReserveSpec {
  emergency: number // 急救最低班次（额度，最先扣）
  transit: number // 公交最低班次（额度，次先扣）
}

export interface WindowInput {
  key: string // 窗口键，一般为 路段|日期|半小时槽位
  label: string // 可读名称
  capacity: number // 该半小时路面总容量（标准班次/当量）
  reserve: ReserveSpec
}

export interface OccupancySource {
  reqNo: string
  kind: SourceKind
  amount: number
  client?: string
}

export interface WindowLedger {
  key: string
  label: string
  capacity: number
  reserve: ReserveSpec
  used: number
  sources: OccupancySource[]
  occupantReqNos: string[] // 已在该窗口生效的施工请求号
  verified: boolean
}

export interface PassageRequest {
  reqNo: string // 原请求号：续跑复用，绝不重新发号
  client: string // 提交人（两人并发用）
  windowKey: string
  amount: number
  source: string // 施工占用来源描述（阶段/用途）
  status: RequestStatus
  blockReason?: string // 排队/冲突时标明占用来源
  fingerprint: number // 最近一次预占所依据的输入指纹
}

export interface Signoff {
  stageId: string
  unit: AgencyUnit
  author: string
  opinion: string
  fingerprint: number // 会签时锚定的输入指纹；指纹一变即失效
  status: '有效' | '失效'
}

export interface LedgerSnapshot {
  fingerprint: number
  windows: WindowInput[]
  requests: PassageRequest[]
  ledgers: Record<string, WindowLedger>
  signoffs: Signoff[]
  notice: { state: 'blocked'; reasons: string[] } | { state: 'ready'; fingerprint: number; text: string }
  log: string[] // 审计流水
}

export const SIGN_UNITS: AgencyUnit[] = ['交警', '公交', '急救', '建设']

function clone<T>(value: T): T {
  return structuredClone(value)
}

// 创建初始账本：急救/公交保留额度作为最先登记的占用来源。
export function createLedger(windows: WindowInput[], fingerprint = 1): LedgerSnapshot {
  const ledgers: Record<string, WindowLedger> = {}
  for (const w of windows) ledgers[w.key] = emptyWindow(w)
  const next: LedgerSnapshot = {
    fingerprint,
    windows,
    requests: [],
    ledgers,
    signoffs: [],
    notice: { state: 'blocked', reasons: ['尚无任何预占与会签'] },
    log: [`建账：${windows.length} 个半小时窗口，输入指纹 F${fingerprint}`],
  }
  return recompute(next, '建账登记急救/公交最低班次额度')
}

function emptyWindow(w: WindowInput): WindowLedger {
  return {
    key: w.key, label: w.label, capacity: w.capacity,
    reserve: { ...w.reserve }, used: 0, sources: [], occupantReqNos: [], verified: false,
  }
}

// 依据当前窗口输入与请求队列全量重算预占。
// 保留额度（急救、公交）始终先扣；施工请求按请求号顺序吃剩余容量。
// 冲突态请求不参与扣额度；排队/预占请求按原请求号重放，绝不重复扣额度。
function recompute(prev: LedgerSnapshot, reason: string): LedgerSnapshot {
  const next = clone(prev)
  const priorVerified = new Set(
    Object.values(prev.ledgers).filter((w) => w.verified).map((w) => w.key),
  )
  const ledgers: Record<string, WindowLedger> = {}
  for (const w of next.windows) {
    const led = emptyWindow(w)
    // 同指纹重算保留核对状态；指纹变化时未核对窗口一律清零
    if (next.fingerprint === prev.fingerprint && priorVerified.has(w.key)) led.verified = true
    ledgers[w.key] = led
  }
  // 1) 最低班次额度先扣
  for (const key of Object.keys(ledgers)) {
    const res = ledgers[key].reserve
    if (res.emergency > 0) pushSource(ledgers[key], { reqNo: 'RES-急救', kind: '急救保留', amount: res.emergency })
    if (res.transit > 0) pushSource(ledgers[key], { reqNo: 'RES-公交', kind: '公交保留', amount: res.transit })
  }
  // 2) 施工请求按原请求号顺序预占；放不下的排队并标明占用来源；冲突态不动
  for (const req of next.requests) {
    req.fingerprint = next.fingerprint
    if (req.status === '冲突') continue
    const led = ledgers[req.windowKey]
    if (!led) { req.status = '排队中'; req.blockReason = '窗口已随方案变更消失，待改派'; continue }
    if (led.used + req.amount <= led.capacity) {
      pushSource(led, { reqNo: req.reqNo, kind: '施工预占', amount: req.amount, client: req.client })
      if (!led.occupantReqNos.includes(req.reqNo)) led.occupantReqNos.push(req.reqNo)
      req.status = '已预占'
      req.blockReason = undefined
    } else {
      req.status = '排队中'
      req.blockReason = describeOccupancy(led, req.amount)
    }
  }
  next.ledgers = ledgers
  refreshNotice(next)
  next.log.push(`重算（${reason}）｜指纹 F${next.fingerprint}｜${Object.keys(ledgers).length} 窗口`)
  return next
}

function pushSource(led: WindowLedger, src: OccupancySource) {
  led.used += src.amount
  led.sources.push(src)
}

function describeOccupancy(led: WindowLedger, need: number): string {
  const remain = led.capacity - led.used
  const who = led.sources
    .map((s) => (s.kind === '施工预占' ? `施工预占:${s.reqNo}×${s.amount}` : `${s.kind}×${s.amount}`))
    .join('、')
  return `仅剩 ${remain}，需 ${need}；占用来源：${who || '无'}`
}

export interface SubmitInput {
  reqNo: string
  client: string
  windowKey: string
  amount: number
  source: string
}

export interface SubmitOutcome {
  ledger: LedgerSnapshot
  status: RequestStatus
  reason?: string
  duplicate?: boolean
}

// 顺序提交（非同时）：直接按剩余容量预占或排队，不触发首写冲突。
// 同一请求号重复提交为幂等重放：回显现状，不二次扣额度、不重新发号。
export function submit(prev: LedgerSnapshot, input: SubmitInput): SubmitOutcome {
  const existing = prev.requests.find((r) => r.reqNo === input.reqNo)
  if (existing) {
    return { ledger: prev, status: existing.status, duplicate: true, reason: `请求号 ${input.reqNo} 已存在，幂等回显，不重复扣额度` }
  }
  let next = clone(prev)
  next.requests.push({ ...input, status: '排队中', fingerprint: prev.fingerprint })
  next.log.push(`提交 ${input.reqNo}｜${input.client}｜窗口 ${input.windowKey}｜需求 ${input.amount}`)
  next = recompute(next, `提交 ${input.reqNo}`)
  const placed = next.requests.find((r) => r.reqNo === input.reqNo)!
  return { ledger: next, status: placed.status, reason: placed.blockReason }
}

// 同一窗口"两人同时提交"：在一个提交回合内竞首写锁。
// 每窗口首写者按容量预占；放不下则记冲突（标明当前占用来源），不进队列、不扣额度。
// 后到者无论容量是否足够，一律记冲突并标明首写来源，不扣额度。
// 传入顺序即到达顺序；返回与 inputs 等长、同序。
export function submitConcurrent(prev: LedgerSnapshot, inputs: SubmitInput[]): SubmitOutcome[] {
  let next = clone(prev)
  const firstWriter = new Map<string, SubmitInput>() // windowKey -> 首写请求
  const outcomes: (SubmitOutcome | null)[] = inputs.map(() => null)
  const firstWriterReqNos = new Set<string>()

  for (let i = 0; i < inputs.length; i += 1) {
    const input = inputs[i]
    if (next.requests.some((r) => r.reqNo === input.reqNo)) {
      const existing = next.requests.find((r) => r.reqNo === input.reqNo)!
      outcomes[i] = { ledger: next, status: existing.status, duplicate: true, reason: `请求号 ${input.reqNo} 已存在，幂等回显` }
      continue
    }
    const holder = firstWriter.get(input.windowKey)
    if (holder) {
      // 后到留冲突：标明占用来源（首写方），不扣额度
      next.requests.push({
        ...input, status: '冲突',
        blockReason: `窗口首写被 ${holder.reqNo}（${holder.client}·${holder.source}）取得，后到留冲突`,
        fingerprint: next.fingerprint,
      })
      next.log.push(`同时提交 ${input.reqNo}｜${input.client}｜窗口 ${input.windowKey}｜冲突（首写 ${holder.reqNo}）`)
      outcomes[i] = { ledger: next, status: '冲突', reason: holder.reqNo }
    } else {
      firstWriter.set(input.windowKey, input)
      firstWriterReqNos.add(input.reqNo)
      next.requests.push({ ...input, status: '排队中', fingerprint: next.fingerprint })
      next.log.push(`同时提交 ${input.reqNo}｜${input.client}｜窗口 ${input.windowKey}｜取得首写`)
    }
  }
  // 首写请求单独按容量判定：放不下 → 冲突（被既有占用挡住），不是排队
  const priorLedgers = next.ledgers
  const priorVerified = new Set(Object.values(priorLedgers).filter((w) => w.verified).map((w) => w.key))
  next.ledgers = {}
  for (const w of next.windows) {
    const led = emptyWindow(w)
    if (priorVerified.has(w.key)) led.verified = true
    next.ledgers[w.key] = led
  }
  for (const key of Object.keys(next.ledgers)) {
    const res = next.ledgers[key].reserve
    if (res.emergency > 0) pushSource(next.ledgers[key], { reqNo: 'RES-急救', kind: '急救保留', amount: res.emergency })
    if (res.transit > 0) pushSource(next.ledgers[key], { reqNo: 'RES-公交', kind: '公交保留', amount: res.transit })
  }
  // 既有请求按原请求号顺序先重放（排队的可能正好腾入），新首写请求随后竞容量；放不下 → 冲突
  for (const req of next.requests) {
    if (req.status === '冲突' || firstWriterReqNos.has(req.reqNo)) continue
    const led = next.ledgers[req.windowKey]
    if (!led) { req.status = '排队中'; req.blockReason = '窗口已随方案变更消失，待改派'; continue }
    if (led.used + req.amount <= led.capacity) {
      pushSource(led, { reqNo: req.reqNo, kind: '施工预占', amount: req.amount, client: req.client })
      if (!led.occupantReqNos.includes(req.reqNo)) led.occupantReqNos.push(req.reqNo)
      req.status = '已预占'
      req.blockReason = undefined
    } else {
      req.status = '排队中'
      req.blockReason = describeOccupancy(led, req.amount)
    }
  }
  for (const req of next.requests) {
    if (!firstWriterReqNos.has(req.reqNo)) continue
    const led = next.ledgers[req.windowKey]
    if (!led) { req.status = '冲突'; req.blockReason = '窗口已随方案变更消失'; continue }
    if (led.used + req.amount <= led.capacity) {
      pushSource(led, { reqNo: req.reqNo, kind: '施工预占', amount: req.amount, client: req.client })
      led.occupantReqNos.push(req.reqNo)
      req.status = '已预占'
      req.blockReason = undefined
    } else {
      req.status = '冲突'
      req.blockReason = `首写时窗口已被占：${describeOccupancy(led, req.amount)}`
    }
  }
  // 冲突态请求的指纹刷新
  for (const req of next.requests) req.fingerprint = next.fingerprint
  refreshNotice(next)
  next.log.push(`同时提交回合（${inputs.length} 笔）结算｜指纹 F${next.fingerprint}`)
  for (let i = 0; i < inputs.length; i += 1) {
    const out = outcomes[i]
    if (out) { out.ledger = next; continue }
    const req = next.requests.find((r) => r.reqNo === inputs[i].reqNo)!
    outcomes[i] = { ledger: next, status: req.status, reason: req.blockReason }
  }
  return outcomes as SubmitOutcome[]
}

// 失败后按原请求号续跑：不重新发号、不重复扣额度。
// 排队中：容量腾出即升入预占；冲突：重放一次（首写释放后即生效，仍不足则转排队）。
export function retry(prev: LedgerSnapshot, reqNo: string): SubmitOutcome {
  const req = prev.requests.find((r) => r.reqNo === reqNo)
  if (!req) return { ledger: prev, status: '排队中', reason: '请求不存在' }
  if (req.status === '已预占') return { ledger: prev, status: '已预占', reason: '已生效，幂等返回' }
  let next = clone(prev)
  const target = next.requests.find((r) => r.reqNo === reqNo)!
  if (target.status === '冲突') {
    // 原请求号续跑：冲突解除后重新参与容量判定（不换号、不新发）
    target.status = '排队中'
    target.blockReason = undefined
    next.log.push(`冲突续跑 ${reqNo}：凭原请求号重新参与窗口 ${req.windowKey} 判定`)
  } else {
    next.log.push(`排队续跑 ${reqNo}：重算窗口 ${req.windowKey} 容量`)
  }
  next = recompute(next, `续跑 ${reqNo}`)
  const after = next.requests.find((r) => r.reqNo === reqNo)!
  return { ledger: next, status: after.status, reason: after.blockReason }
}

// 撤回一个施工请求，腾让容量后队列自动重算（请求号注销，不再占用）。
export function release(prev: LedgerSnapshot, reqNo: string): LedgerSnapshot {
  const req = prev.requests.find((r) => r.reqNo === reqNo)
  if (!req) return prev
  let next = clone(prev)
  next.requests = next.requests.filter((r) => r.reqNo !== reqNo)
  next = recompute(next, `释放 ${reqNo}`)
  next.log.push(`释放 ${reqNo}：窗口 ${req.windowKey} 腾出 ${req.amount} 容量，队列重排`)
  return next
}

export interface InputChange {
  stagesChanged?: boolean
  detoursChanged?: boolean
  windows?: WindowInput[] // 时间/绕行变化后重排的窗口表；缺省时沿用旧窗口
  remap?: Record<string, string> // 旧窗口键 → 新窗口键（改期改线重挂）
}

// 时间或绕行一变：指纹+1，预占失效重算、会签失效、通告草稿作废、未核对窗口清零。
export function bumpInput(prev: LedgerSnapshot, change: InputChange): LedgerSnapshot {
  let next = clone(prev)
  next.fingerprint += 1
  const what = [change.stagesChanged && '阶段时间', change.detoursChanged && '绕行路线'].filter(Boolean).join('、')
  if (change.windows) next.windows = clone(change.windows)
  // 请求重挂到改期/改线后的窗口
  for (const r of next.requests) {
    const mapped = change.remap?.[r.windowKey]
    if (mapped) r.windowKey = mapped
    if (r.status === '冲突') {
      r.blockReason = `原冲突已随${what || '输入'}变更（F${next.fingerprint}）解锁，请凭原请求号续跑`
    }
  }
  // 会签锚定旧指纹 → 全部失效
  for (const s of next.signoffs) s.status = '失效'
  next = recompute(next, `${what}变更`)
  next.log.push(`输入变更（${what}）→ 指纹 F${next.fingerprint}：预占重算、会签失效、通告草稿作废、核对清零`)
  return next
}

// 核对窗口：存在排队/冲突请求的窗口不得核对。
export function verifyWindow(prev: LedgerSnapshot, key: string, verified: boolean): LedgerSnapshot {
  if (verified) {
    const blocked = prev.requests.some((r) => r.windowKey === key && r.status !== '已预占')
    if (blocked) return prev
  }
  const next = clone(prev)
  if (next.ledgers[key]) next.ledgers[key].verified = verified
  refreshNotice(next)
  next.log.push(`窗口 ${next.ledgers[key]?.label ?? key} 核对${verified ? '通过' : '撤销'}`)
  return next
}

export interface SignoffInput {
  stageId: string
  unit: AgencyUnit
  author: string
  opinion: string
}

// 条件会签：锚定当前输入指纹。指纹一变即失效，须在重算后重签。
export function addSignoff(prev: LedgerSnapshot, input: SignoffInput): LedgerSnapshot {
  const next = clone(prev)
  const idx = next.signoffs.findIndex((s) => s.stageId === input.stageId && s.unit === input.unit)
  const record: Signoff = { ...input, fingerprint: next.fingerprint, status: '有效' }
  if (idx >= 0) next.signoffs[idx] = record
  else next.signoffs.push(record)
  refreshNotice(next)
  next.log.push(`会签 ${input.stageId}·${input.unit}（${input.author}）锚定 F${next.fingerprint}`)
  return next
}

export function stageIdsOf(ledger: LedgerSnapshot): string[] {
  const ids = new Set<string>()
  ledger.requests.forEach((r) => {
    const m = r.source.match(/\((ST-\d+)\)/)
    if (m) ids.add(m[1])
  })
  ledger.signoffs.forEach((s) => ids.add(s.stageId))
  return [...ids]
}

// 通告闸门：未核对窗口清零前，或有排队/冲突、会签失效/缺失，均不出通告。
function refreshNotice(next: LedgerSnapshot) {
  const reasons: string[] = []
  next.requests.filter((r) => r.status === '排队中').forEach((r) => reasons.push(`请求 ${r.reqNo} 仍在排队：${r.blockReason}`))
  next.requests.filter((r) => r.status === '冲突').forEach((r) => reasons.push(`请求 ${r.reqNo} 存在首写冲突：${r.blockReason}`))
  for (const w of Object.values(next.ledgers)) {
    if (!w.verified) reasons.push(`窗口「${w.label}」尚未核对`)
  }
  for (const stageId of stageIdsOf(next)) {
    for (const unit of SIGN_UNITS) {
      const s = next.signoffs.find((x) => x.stageId === stageId && x.unit === unit)
      if (!s) reasons.push(`阶段 ${stageId} 缺 ${unit} 会签`)
      else if (s.status !== '有效' || s.fingerprint !== next.fingerprint) {
        reasons.push(`阶段 ${stageId}·${unit} 会签已随输入变更失效，须重签`)
      }
    }
  }
  next.notice = reasons.length
    ? { state: 'blocked', reasons }
    : { state: 'ready', fingerprint: next.fingerprint, text: buildNoticeText(next) }
}

function buildNoticeText(led: LedgerSnapshot): string {
  const lines = ['施工通行通告（草稿）', `输入版本 F${led.fingerprint}`, '']
  for (const w of Object.values(led.ledgers)) {
    lines.push(`【${w.label}】容量 ${w.capacity}｜已用 ${w.used}｜急救保底 ${w.reserve.emergency}｜公交保底 ${w.reserve.transit}｜已核对`)
    w.sources.forEach((s) => lines.push(`  - ${s.kind} ${s.kind === '施工预占' ? s.reqNo : ''} ${s.client ? '(' + s.client + ')' : ''} 占用 ${s.amount}`))
  }
  lines.push('', '会签：交警 / 公交 / 急救 / 建设 均已在 F' + led.fingerprint + ' 上签署。')
  return lines.join('\n')
}

export function canPublish(led: LedgerSnapshot): boolean {
  return led.notice.state === 'ready'
}
