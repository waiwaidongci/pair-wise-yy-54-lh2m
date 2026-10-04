import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { useSchemeStore } from './scheme'
import type {
  ApplicationRequest,
  Countersign,
  NoticeDraft,
  Occupation,
  OccupationSource,
  QueueItem,
  RequestTicket,
  TicketStatus,
  WindowSlot,
} from '../types'

// ─────────────────────────────────────────────────────────────
// 通行账（Traffic Ledger）
// 把施工阶段、绕行路线、会签意见和通告接成一本按半小时窗口
// 分配路面额度的账。核心规则：
//   1. 急救/公交最低班次留额度（每窗口预留）。
//   2. 施工申请按剩余容量预占，超额排队并标明占用来源。
//   3. 时间或绕行一变 → 预占、会签、通告草稿失效重算。
//   4. 两人同时提交同一窗口 → 首写生效，后到留冲突。
//   5. 失败后按原请求号续跑，不重复扣额度。
//   6. 未核对窗口清零前不出通告。
// ─────────────────────────────────────────────────────────────

const STORAGE_KEY = 'yy54-road-ledger-v1'
const OPEN_HOUR = 7   // 运营时段 07:00
const CLOSE_HOUR = 19 // 至 19:00，共 24 个半小时窗口

function pad(n: number) { return String(n).padStart(2, '0') }

function datesBetween(start: string, end: string): string[] {
  const dates: string[] = []
  const d = new Date(start + 'T00:00:00')
  const e = new Date(end + 'T00:00:00')
  while (d <= e) {
    dates.push(d.toISOString().slice(0, 10))
    d.setDate(d.getDate() + 1)
  }
  return dates
}

function halfHourSlots(): { start: string; end: string }[] {
  const slots: { start: string; end: string }[] = []
  let h = OPEN_HOUR
  let m = 0
  while (h < CLOSE_HOUR || (h === CLOSE_HOUR && m < 0)) {
    const start = `${pad(h)}:${pad(m)}`
    m += 30
    if (m >= 60) { h += 1; m = 0 }
    const end = `${pad(h)}:${pad(m)}`
    slots.push({ start, end })
    if (h >= CLOSE_HOUR) break
  }
  return slots
}

/** 按阶段决定窗口容量与急救/公交预留：全封闭夜间容量收紧。 */
function capacityFor(stages: { start: string; end: string; lanes: string }[], date: string) {
  const stage = stages.find((s) => s.start <= date && date <= s.end)
  const fullClosure = stage?.lanes.includes('全封闭')
  if (fullClosure) return { capacity: 4, reservedEmergency: 1, reservedBus: 1 }
  return { capacity: 10, reservedEmergency: 2, reservedBus: 3 }
}

function buildWindows(stages: { start: string; end: string; lanes: string }[]): WindowSlot[] {
  if (stages.length === 0) return []
  const dates = datesBetween(stages.map((s) => s.start).sort()[0], stages.map((s) => s.end).sort().reverse()[0])
  const slots = halfHourSlots()
  const windows: WindowSlot[] = []
  for (const date of dates) {
    const cap = capacityFor(stages, date)
    for (const slot of slots) {
      windows.push({
        id: `W-${date}-${slot.start}`,
        date,
        start: slot.start,
        end: slot.end,
        capacity: cap.capacity,
        reservedEmergency: cap.reservedEmergency,
        reservedBus: cap.reservedBus,
        version: 1,
        status: '待核对',
      })
    }
  }
  return windows
}

/** 阶段/绕行的布局签名：时间或绕行一变，签名就变，触发失效重算。 */
function layoutSignature(stages: { start: string; end: string; route: unknown; lanes: string }[], detours: { coordinates: unknown; extraMinutes: number }[]) {
  return JSON.stringify({
    stages: stages.map((s) => [s.start, s.end, s.lanes, s.route]),
    detours: detours.map((d) => [d.coordinates, d.extraMinutes]),
  })
}

export const useLedgerStore = defineStore('ledger', () => {
  const scheme = useSchemeStore()

  const windows = ref<WindowSlot[]>([])
  const occupations = ref<Occupation[]>([])
  const queue = ref<QueueItem[]>([])
  const conflicts = ref<{ id: string; windowId: string; requestNo: string; source: OccupationSource; amount: number; baseVersion: number; currentVersion: number; reason: string; createdAt: number }[]>([])
  const tickets = ref<RequestTicket[]>([])
  const countersigns = ref<Countersign[]>([])
  const noticeDrafts = ref<NoticeDraft[]>([])
  const applications = ref<ApplicationRequest[]>([])
  const layoutVersion = ref(1)
  const selectedDate = ref('')
  const lastRecalcAt = ref<number | null>(null)
  const lastMessage = ref('')

  // ── 派生 ──────────────────────────────────────────────
  const dates = computed(() => [...new Set(windows.value.map((w) => w.date))].sort())
  const timeSlots = computed(() => {
    const map = new Map<string, { start: string; end: string }>()
    windows.value.forEach((w) => { if (!map.has(w.start)) map.set(w.start, { start: w.start, end: w.end }) })
    return [...map.values()].sort((a, b) => a.start.localeCompare(b.start))
  })
  const windowsByDate = computed(() => {
    const map = new Map<string, WindowSlot[]>()
    windows.value.forEach((w) => {
      if (!map.has(w.date)) map.set(w.date, [])
      map.get(w.date)!.push(w)
    })
    map.forEach((list) => list.sort((a, b) => a.start.localeCompare(b.start)))
    return map
  })
  const selectedWindows = computed(() => windowsByDate.value.get(selectedDate.value) || [])

  function findWindow(windowId: string) { return windows.value.find((w) => w.id === windowId) }

  function occupiedBySource(windowId: string) {
    const by = { 急救: 0, 公交: 0, 施工: 0, 交警: 0 }
    occupations.value
      .filter((o) => o.windowId === windowId && o.status === '预占')
      .forEach((o) => { by[o.source] += o.amount })
    return by
  }
  function usedCapacity(windowId: string) {
    const w = findWindow(windowId)
    if (!w) return 0
    const occ = occupiedBySource(windowId)
    return w.reservedEmergency + w.reservedBus + occ.施工 + occ.交警
  }
  function remainingCapacity(windowId: string) {
    const w = findWindow(windowId)
    if (!w) return 0
    return w.capacity - usedCapacity(windowId)
  }
  function queuedAmount(windowId: string) {
    return queue.value.filter((q) => q.windowId === windowId && q.status === '排队中').reduce((s, q) => s + q.amount, 0)
  }
  function windowConflicts(windowId: string) {
    return conflicts.value.filter((c) => c.windowId === windowId)
  }
  function utilization(windowId: string) {
    const w = findWindow(windowId)
    if (!w || w.capacity === 0) return 0
    return usedCapacity(windowId) / w.capacity
  }
  function utilizationColor(windowId: string) {
    const u = utilization(windowId)
    if (u >= 1) return '#e11d48'
    if (u >= 0.7) return '#f59e0b'
    return '#16a34a'
  }

  /** 窗口清零：无排队项才算核对通过；冲突是审计记录，不阻塞。 */
  function isCleared(windowId: string) {
    const w = findWindow(windowId)
    if (!w) return false
    return w.status === '已核对' && queuedAmount(windowId) === 0
  }

  const allCleared = computed(() =>
    windows.value.length > 0 &&
    windows.value.every((w) => w.status === '已核对') &&
    queue.value.every((q) => q.status !== '排队中'),
  )
  const canPublishNotice = computed(() => allCleared.value)
  const pendingQueueCount = computed(() => queue.value.filter((q) => q.status === '排队中').length)
  const pendingConflictCount = computed(() => conflicts.value.length)
  const verifiedCount = computed(() => windows.value.filter((w) => w.status === '已核对').length)

  // ── 持久化 ────────────────────────────────────────────
  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      windows: windows.value, occupations: occupations.value, queue: queue.value,
      conflicts: conflicts.value, tickets: tickets.value, countersigns: countersigns.value,
      noticeDrafts: noticeDrafts.value, applications: applications.value,
      layoutVersion: layoutVersion.value, selectedDate: selectedDate.value,
    }))
  }
  function restore() {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return false
    try {
      const data = JSON.parse(raw)
      windows.value = data.windows || []
      occupations.value = data.occupations || []
      queue.value = data.queue || []
      conflicts.value = data.conflicts || []
      tickets.value = data.tickets || []
      countersigns.value = data.countersigns || []
      noticeDrafts.value = data.noticeDrafts || []
      applications.value = data.applications || []
      layoutVersion.value = data.layoutVersion || 1
      selectedDate.value = data.selectedDate || ''
      return true
    } catch { return false }
  }

  // ── 申请提交（幂等 + 乐观并发）────────────────────────
  function nextRequestNo() {
    const n = applications.value.length + 1
    return `REQ-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(n).padStart(3, '0')}`
  }

  function createTicket(req: ApplicationRequest): RequestTicket {
    return {
      requestNo: req.requestNo, windowId: req.windowId, source: req.source, amount: req.amount,
      status: '失败', attempts: 0, createdAt: Date.now(),
    }
  }

  /**
   * 提交申请。幂等：同一请求号若已有生效票据，直接返回原结果，不重复扣额度。
   * 乐观并发：窗口版本与 baseVersion 不一致 → 首写已生效，后到留冲突。
   */
  function submitApplication(req: ApplicationRequest & { baseVersion?: number }): { status: TicketStatus; ticket: RequestTicket; message: string } {
    // 登记原始申请（用于失效重算）
    if (!applications.value.some((a) => a.requestNo === req.requestNo)) {
      applications.value.push({ requestNo: req.requestNo, windowId: req.windowId, source: req.source, amount: req.amount, stageId: req.stageId, detourId: req.detourId })
    }

    const existing = tickets.value.find((t) => t.requestNo === req.requestNo)
    if (existing) {
      const liveOcc = existing.occupationId && occupations.value.some((o) => o.id === existing.occupationId && o.status === '预占')
      const liveQueue = existing.queueId && queue.value.some((q) => q.id === existing.queueId && q.status === '排队中')
      if (existing.status === '成功' && liveOcc) {
        return { status: existing.status, ticket: existing, message: `请求号 ${req.requestNo} 已预占，不重复扣减额度` }
      }
      if (existing.status === '排队' && (liveOcc || liveQueue)) {
        return { status: existing.status, ticket: existing, message: `请求号 ${req.requestNo} 已排队，不重复扣减额度` }
      }
      // 票据已失效（布局变更）或失败/冲突 → 落到下面重新尝试
    }

    const ticket = existing ?? createTicket(req)
    if (!existing) tickets.value.push(ticket)
    ticket.windowId = req.windowId
    ticket.amount = req.amount
    ticket.source = req.source
    ticket.attempts += 1

    const w = findWindow(req.windowId)
    if (!w) {
      ticket.status = '失败'
      ticket.lastError = '窗口不存在（可能随施工阶段调整而消失）'
      lastMessage.value = `请求号 ${req.requestNo} 失败：窗口不存在`
      persist()
      return { status: '失败', ticket, message: ticket.lastError }
    }

    const baseVersion = req.baseVersion ?? w.version

    // 乐观并发：首写生效，后到留冲突
    if (w.version !== baseVersion) {
      const conflictId = ticket.conflictId ?? `CF-${String(conflicts.value.length + 1).padStart(3, '0')}`
      if (!ticket.conflictId) {
        conflicts.value.push({
          id: conflictId, windowId: req.windowId, requestNo: req.requestNo, source: req.source,
          amount: req.amount, baseVersion, currentVersion: w.version,
          reason: `窗口版本已更新（v${baseVersion} → v${w.version}），首写已生效，后到保留冲突`,
          createdAt: Date.now(),
        })
        ticket.conflictId = conflictId
      } else {
        const c = conflicts.value.find((x) => x.id === conflictId)
        if (c) {
          c.baseVersion = baseVersion
          c.currentVersion = w.version
          c.reason = `窗口版本已更新（v${baseVersion} → v${w.version}），首写已生效，后到保留冲突`
        }
      }
      ticket.status = '冲突'
      ticket.lastError = `版本冲突 v${baseVersion}≠v${w.version}`
      lastMessage.value = `请求号 ${req.requestNo} 冲突：窗口 v${w.version} 已被首写更新`
      persist()
      return { status: '冲突', ticket, message: ticket.lastError }
    }

    const remaining = remainingCapacity(req.windowId)
    if (req.amount <= remaining) {
      // 全部预占（失效重算后重新生成预占记录，不复用旧 ID）
      const occId = `OC-${String(occupations.value.length + 1).padStart(3, '0')}`
      occupations.value.push({
        id: occId, windowId: req.windowId, source: req.source, requestNo: req.requestNo,
        amount: req.amount, stageId: req.stageId, detourId: req.detourId,
        status: '预占', baseVersion, layoutVersion: layoutVersion.value, createdAt: Date.now(),
      })
      ticket.occupationId = occId
      ticket.queueId = undefined
      w.version += 1
      ticket.status = '成功'
      ticket.lastError = undefined
      lastMessage.value = `请求号 ${req.requestNo} 预占成功 ${req.amount} 个额度`
      persist()
      return { status: '成功', ticket, message: lastMessage.value }
    }

    // 按剩余容量预占，超额排队并标明占用来源
    if (remaining > 0) {
      const occId = `OC-${String(occupations.value.length + 1).padStart(3, '0')}`
      occupations.value.push({
        id: occId, windowId: req.windowId, source: req.source, requestNo: req.requestNo,
        amount: remaining, stageId: req.stageId, detourId: req.detourId,
        status: '预占', baseVersion, layoutVersion: layoutVersion.value, createdAt: Date.now(),
      })
      ticket.occupationId = occId
    }
    const shortfall = req.amount - remaining
    const qId = `QU-${String(queue.value.length + 1).padStart(3, '0')}`
    queue.value.push({
      id: qId, windowId: req.windowId, requestNo: req.requestNo, source: req.source,
      amount: shortfall, stageId: req.stageId,
      reason: `占用来源：急救预留 ${w.reservedEmergency} + 公交预留 ${w.reservedBus}，剩余 ${remaining}，申请 ${req.amount}，超额 ${shortfall} 排队`,
      status: '排队中', layoutVersion: layoutVersion.value, createdAt: Date.now(),
    })
    ticket.queueId = qId
    w.version += 1
    ticket.status = '排队'
    ticket.lastError = undefined
    lastMessage.value = `请求号 ${req.requestNo} 预占 ${remaining}，排队 ${shortfall}（超额）`
    persist()
    return { status: '排队', ticket, message: lastMessage.value }
  }

  /** 失败/冲突后按原请求号续跑：取窗口当前版本作为 baseVersion，不重复扣额度。 */
  function retryTicket(requestNo: string) {
    const ticket = tickets.value.find((t) => t.requestNo === requestNo)
    if (!ticket) return
    const w = findWindow(ticket.windowId)
    const baseVersion = w ? w.version : 1
    lastMessage.value = `按原请求号 ${requestNo} 续跑（第 ${ticket.attempts + 1} 次）`
    return submitApplication({
      requestNo: ticket.requestNo, windowId: ticket.windowId, source: ticket.source,
      amount: ticket.amount, baseVersion,
    })
  }

  /** 撤销预占，释放额度，并尝试把排队项顶上（清零）。 */
  function withdrawOccupation(occupationId: string) {
    const occ = occupations.value.find((o) => o.id === occupationId)
    if (!occ) return
    const windowId = occ.windowId
    occupations.value = occupations.value.filter((o) => o.id !== occupationId)
    const ticket = tickets.value.find((t) => t.occupationId === occupationId)
    if (ticket) { ticket.status = '已撤销'; ticket.occupationId = undefined }
    const w = findWindow(windowId)
    if (w) w.version += 1
    autoAllocateQueue(windowId)
    lastMessage.value = `已撤销 ${occ.requestNo} 的预占，释放 ${occ.amount} 个额度`
    persist()
  }

  /** 排队项撤销。 */
  function withdrawQueue(queueId: string) {
    const q = queue.value.find((x) => x.id === queueId)
    if (!q) return
    queue.value = queue.value.filter((x) => x.id !== queueId)
    const ticket = tickets.value.find((t) => t.queueId === queueId)
    if (ticket) { ticket.status = '已撤销'; ticket.queueId = undefined }
    const w = findWindow(q.windowId)
    if (w) w.version += 1
    lastMessage.value = `已撤销 ${q.requestNo} 的排队`
    persist()
  }

  /** 释放额度后，按请求顺序把排队项转为预占。 */
  function autoAllocateQueue(windowId: string) {
    const queued = queue.value
      .filter((q) => q.windowId === windowId && q.status === '排队中')
      .sort((a, b) => a.createdAt - b.createdAt)
    for (const q of queued) {
      const remaining = remainingCapacity(windowId)
      if (q.amount <= remaining) {
        const occId = `OC-${String(occupations.value.length + 1).padStart(3, '0')}`
        occupations.value.push({
          id: occId, windowId, source: q.source, requestNo: q.requestNo,
          amount: q.amount, stageId: q.stageId,
          status: '预占', baseVersion: findWindow(windowId)?.version ?? 1,
          layoutVersion: layoutVersion.value, createdAt: Date.now(),
        })
        q.status = '已分配'
        q.occupationId = occId
        const ticket = tickets.value.find((t) => t.requestNo === q.requestNo)
        if (ticket) { ticket.status = '成功'; ticket.queueId = undefined; ticket.occupationId = occId }
        const w = findWindow(windowId)
        if (w) w.version += 1
      }
    }
  }

  /** 核对窗口：排队清零即核对通过；冲突是审计记录，不阻塞核对。 */
  function reconcileWindows() {
    windows.value.forEach((w) => {
      const hasQueue = queue.value.some((q) => q.windowId === w.id && q.status === '排队中')
      w.status = !hasQueue ? '已核对' : '待核对'
    })
    lastMessage.value = allCleared.value ? '全部窗口已核对清零' : '仍有窗口未清零（排队未解决）'
    persist()
  }

  // ── 失效重算 ──────────────────────────────────────────
  /** 时间或绕行一变：预占、会签、通告草稿失效，窗口回到待核对。 */
  function invalidateLayout() {
    layoutVersion.value += 1
    occupations.value.forEach((o) => { if (o.status === '预占') o.status = '失效' })
    queue.value.forEach((q) => { if (q.status === '排队中') q.status = '失效' })
    countersigns.value.forEach((c) => { if (c.status === '有效') c.status = '待重新会签' })
    noticeDrafts.value.forEach((n) => { if (n.status === '草稿') n.status = '已失效' })
    windows.value.forEach((w) => { w.status = '待核对'; w.version = 1 })
    lastMessage.value = `检测到施工阶段/绕行变更，预占、会签、通告草稿已失效（layout v${layoutVersion.value}）`
    persist()
  }

  /** 失效后重算：重建窗口，按原请求号重跑，不重复扣额度。 */
  function recalculate() {
    invalidateLayout()
    windows.value = buildWindows(scheme.scheme.stages)
    if (!selectedDate.value || !dates.value.includes(selectedDate.value)) {
      selectedDate.value = dates.value[0] || ''
    }
    // 按原请求号重跑（幂等：已失效的票据会重新分配，不重复扣减）
    applications.value.forEach((app) => {
      if (windows.value.some((w) => w.id === app.windowId)) {
        submitApplication({ ...app, baseVersion: findWindow(app.windowId)?.version ?? 1 })
      }
    })
    lastRecalcAt.value = Date.now()
    lastMessage.value = `已失效并重算（layout v${layoutVersion.value}）：窗口 ${windows.value.length} 个，预占/排队按原请求号重跑`
    persist()
  }

  // ── 会签 ──────────────────────────────────────────────
  function addCountersign(unit: Countersign['unit'], author: string, stageId: string, opinion: string) {
    countersigns.value.push({
      id: `CS-${String(countersigns.value.length + 1).padStart(3, '0')}`,
      unit, author, stageId, opinion,
      layoutVersion: layoutVersion.value, status: '有效', createdAt: Date.now(),
    })
    lastMessage.value = `已登记 ${unit} 会签（layout v${layoutVersion.value}）`
    persist()
  }

  // ── 通告 ──────────────────────────────────────────────
  function buildNoticeContent(): string {
    const lines = [
      `${scheme.scheme.project} 施工封路公开通告`,
      `范围：${scheme.scheme.area}`,
      `版本：v${scheme.scheme.version} · 通行账 layout v${layoutVersion.value}`,
      '',
      '施工阶段：',
      ...scheme.scheme.stages.map((s) => `  ${s.start} 至 ${s.end}｜${s.name}｜${s.lanes}`),
      '',
      '绕行建议：',
      ...scheme.scheme.detours.map((d) => `  ${d.name}，增加约 ${d.extraMinutes} 分钟`),
      '',
      '通行账额度分配：',
      `  窗口总数 ${windows.value.length}，已核对 ${verifiedCount.value}，排队 ${pendingQueueCount.value}，冲突 ${pendingConflictCount.value}`,
      '',
      '本通告由建设、交通、公交、应急单位联合确认。',
    ].join('\n')
    return lines
  }

  function saveNoticeDraft() {
    const draft: NoticeDraft = {
      id: `ND-${String(noticeDrafts.value.length + 1).padStart(3, '0')}`,
      version: noticeDrafts.value.length + 1,
      status: '草稿',
      content: buildNoticeContent(),
      layoutVersion: layoutVersion.value,
      createdAt: Date.now(),
    }
    noticeDrafts.value.push(draft)
    lastMessage.value = `已生成通告草稿 v${draft.version}（layout v${layoutVersion.value}）`
    persist()
  }

  /** 未核对窗口清零前不出通告。 */
  function publishNotice(): { ok: boolean; message: string } {
    reconcileWindows()
    if (!allCleared.value) {
      lastMessage.value = '仍有窗口未核对清零，暂不出通告'
      return { ok: false, message: lastMessage.value }
    }
    const draft = noticeDrafts.value[noticeDrafts.value.length - 1]
    if (!draft) {
      lastMessage.value = '请先保存通告草稿'
      return { ok: false, message: lastMessage.value }
    }
    draft.status = '已发布'
    draft.publishedAt = Date.now()
    lastMessage.value = `通告 v${draft.version} 已发布`
    persist()
    return { ok: true, message: lastMessage.value }
  }

  function downloadNotice() {
    const draft = noticeDrafts.value[noticeDrafts.value.length - 1]
    if (!draft) return
    const blob = new Blob([draft.content], { type: 'text/plain;charset=utf-8' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `封路公开通告-${scheme.scheme.id}-v${draft.version}.txt`
    link.click()
    URL.revokeObjectURL(link.href)
  }

  // ── 并发演示：两人同时提交同一窗口 ────────────────────
  function simulateConcurrentSubmit(windowId: string) {
    const w = findWindow(windowId)
    if (!w) return
    const base = w.version
    // 甲先提交（首写生效）
    const a = submitApplication({ requestNo: nextRequestNo(), windowId, source: '施工', amount: 2, baseVersion: base })
    // 乙后提交（同一 baseVersion → 留冲突）
    const b = submitApplication({ requestNo: nextRequestNo(), windowId, source: '交警', amount: 2, baseVersion: base })
    lastMessage.value = `并发演示：甲 ${a.status}（首写生效），乙 ${b.status}（后到留冲突）`
    persist()
  }

  // ── 初始化 ────────────────────────────────────────────
  function init() {
    if (restore() && windows.value.length > 0) {
      if (!selectedDate.value || !dates.value.includes(selectedDate.value)) {
        selectedDate.value = dates.value[0] || ''
      }
      return
    }
    windows.value = buildWindows(scheme.scheme.stages)
    selectedDate.value = dates.value[0] || ''
    seed()
  }

  function seed() {
    // 按容量预占演示：首日（非全封闭，容量 10，急救 2 + 公交 3，剩余 5）
    const firstDay = dates.value[0]
    const w1 = windows.value.find((w) => w.date === firstDay && w.start === '07:00')
    if (w1) {
      submitApplication({ requestNo: 'REQ-SEED-001', windowId: w1.id, source: '施工', amount: 3, baseVersion: 1 })
      submitApplication({ requestNo: 'REQ-SEED-002', windowId: w1.id, source: '施工', amount: 4, baseVersion: w1.version })
    }
    const w2 = windows.value.find((w) => w.date === firstDay && w.start === '08:00')
    if (w2) {
      submitApplication({ requestNo: 'REQ-SEED-003', windowId: w2.id, source: '交警', amount: 2, baseVersion: 1 })
    }
    // 并发演示：同一窗口两笔同 baseVersion，首写生效、后到留冲突
    const w3 = windows.value.find((w) => w.date === firstDay && w.start === '09:00')
    if (w3) {
      submitApplication({ requestNo: 'REQ-SEED-004', windowId: w3.id, source: '施工', amount: 2, baseVersion: 1 })
      submitApplication({ requestNo: 'REQ-SEED-005', windowId: w3.id, source: '交警', amount: 3, baseVersion: 1 })
    }
    // 全封闭夜间窗口（容量 4，急救 1 + 公交 1，剩余 2）：超额排队
    const night = windows.value.find((w) => w.date === '2026-10-23' && w.start === '22:00')
    if (night) {
      submitApplication({ requestNo: 'REQ-SEED-006', windowId: night.id, source: '施工', amount: 3, baseVersion: 1 })
    }
    // 一笔失败票据，用于按原请求号续跑演示
    tickets.value.push({
      requestNo: 'REQ-SEED-007', windowId: 'W-2026-10-08-10:00', source: '施工', amount: 2,
      status: '失败', attempts: 1, lastError: '演示：窗口容量不足', createdAt: Date.now(),
    })
    persist()
  }

  // 时间或绕行一变 → 失效重算
  watch(
    () => layoutSignature(scheme.scheme.stages, scheme.scheme.detours),
    (sig, old) => {
      if (old && sig !== old) {
        invalidateLayout()
        // 自动重算，保持通行账与施工阶段/绕行一致
        windows.value = buildWindows(scheme.scheme.stages)
        if (!selectedDate.value || !dates.value.includes(selectedDate.value)) {
          selectedDate.value = dates.value[0] || ''
        }
        applications.value.forEach((app) => {
          if (windows.value.some((w) => w.id === app.windowId)) {
            submitApplication({ ...app, baseVersion: findWindow(app.windowId)?.version ?? 1 })
          }
        })
        lastRecalcAt.value = Date.now()
        lastMessage.value = `检测到施工阶段/绕行变更，已失效并重算（layout v${layoutVersion.value}）`
        persist()
      }
    },
  )

  init()

  return {
    // state
    windows, occupations, queue, conflicts, tickets, countersigns, noticeDrafts,
    applications, layoutVersion, selectedDate, lastRecalcAt, lastMessage,
    // derived
    dates, timeSlots, selectedWindows,
    occupiedBySource, usedCapacity, remainingCapacity, queuedAmount, windowConflicts,
    utilization, utilizationColor, isCleared, allCleared, canPublishNotice,
    pendingQueueCount, pendingConflictCount, verifiedCount,
    // actions
    nextRequestNo, submitApplication, retryTicket, withdrawOccupation, withdrawQueue,
    autoAllocateQueue, reconcileWindows, invalidateLayout, recalculate,
    addCountersign, saveNoticeDraft, publishNotice, downloadNotice,
    simulateConcurrentSubmit, persist,
  }
})
