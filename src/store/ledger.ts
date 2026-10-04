import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  createLedger, submit, submitConcurrent, retry, release,
  bumpInput, verifyWindow, addSignoff,
  type LedgerSnapshot, type WindowInput, type SubmitInput, type AgencyUnit,
} from '../ledger/engine'

// 半小时槽位（夜间封闭 22:00–05:00 共 14 槽，示例取 4 槽）
const SLOTS = ['22:00–22:30', '22:30–23:00', '23:00–23:30', '23:30–24:00']
const DATE = '2026-10-26'
const STAGE = 'ST-02'

export function buildWindows(date = DATE, capacity = 10, emergency = 3, transit = 2): WindowInput[] {
  return SLOTS.map((slot, i) => ({
    key: `${STAGE}|${date.replace(/-/g, '').slice(4)}|${44 + i}`,
    label: `第二阶段夜间封闭 · ${date} ${slot}`,
    capacity,
    reserve: { emergency, transit },
  }))
}

function seedLedger(): LedgerSnapshot {
  let led = createLedger(buildWindows(), 7)
  led = submit(led, { reqNo: 'REQ-2601', client: '市政建设三处', windowKey: led.windows[0].key, amount: 3, source: '路口夜间围挡 (ST-02)' }).ledger
  led = submit(led, { reqNo: 'REQ-2602', client: '市政建设三处', windowKey: led.windows[1].key, amount: 4, source: '管线横穿开挖 (ST-02)' }).ledger
  led = submit(led, { reqNo: 'REQ-2603', client: '照明分包', windowKey: led.windows[0].key, amount: 4, source: '路灯迁改吊装 (ST-02)' }).ledger // 超额排队
  return led
}

let seq = 2700
function nextReqNo() {
  seq += 1
  return `REQ-${seq}`
}

export const useLedgerStore = defineStore('ledger', () => {
  const ledger = ref<LedgerSnapshot>(seedLedger())
  const lastMessage = ref('账本载入：2 笔预占、1 笔排队（超额标注来源）')
  const selectedWindowKey = ref(ledger.value.windows[0].key)

  const windows = computed(() => ledger.value.windows.map((w) => ledger.value.ledgers[w.key]))
  const requests = computed(() => ledger.value.requests)
  const queuedCount = computed(() => requests.value.filter((r) => r.status === '排队中').length)
  const conflictCount = computed(() => requests.value.filter((r) => r.status === '冲突').length)
  const unverifiedCount = computed(() => Object.values(ledger.value.ledgers).filter((w) => !w.verified).length)
  const canPublish = computed(() => ledger.value.notice.state === 'ready')
  const blockedReasons = computed(() => (ledger.value.notice.state === 'blocked' ? ledger.value.notice.reasons : []))
  const signoffs = computed(() => ledger.value.signoffs)
  const fingerprint = computed(() => ledger.value.fingerprint)

  function flash(msg: string) { lastMessage.value = msg }

  function applySubmit(input: Omit<SubmitInput, 'reqNo'> & { reqNo?: string }, asFirstWrite = false) {
    const full: SubmitInput = { ...input, reqNo: input.reqNo ?? nextReqNo() }
    if (asFirstWrite) {
      const [out] = submitConcurrent(ledger.value, [full])
      ledger.value = out.ledger
      flash(`${full.reqNo} 首写提交 → ${out.status}${out.reason ? '：' + out.reason : ''}`)
      return { reqNo: full.reqNo, ...out }
    }
    const out = submit(ledger.value, full)
    ledger.value = out.ledger
    flash(`${full.reqNo} 提交 → ${out.status}${out.duplicate ? '（原请求号幂等，未重复扣额度）' : ''}${out.reason && out.status !== '已预占' ? '：' + out.reason : ''}`)
    return { reqNo: full.reqNo, ...out }
  }

  // 两人同一窗口同时提交：首写生效，后到留冲突
  function applyConcurrent(a: Omit<SubmitInput, 'reqNo'>, b: Omit<SubmitInput, 'reqNo'>) {
    const ia: SubmitInput = { ...a, reqNo: nextReqNo() }
    const ib: SubmitInput = { ...b, reqNo: nextReqNo() }
    const [oa, ob] = submitConcurrent(ledger.value, [ia, ib])
    ledger.value = oa.ledger
    flash(`同时提交：${ia.reqNo}（${ia.client}）=${oa.status}；${ib.reqNo}（${ib.client}）=${ob.status}（首写生效，后到留冲突，均未重复扣额度）`)
    return [{ reqNo: ia.reqNo, ...oa }, { reqNo: ib.reqNo, ...ob }]
  }

  function applyRetry(reqNo: string) {
    const out = retry(ledger.value, reqNo)
    ledger.value = out.ledger
    flash(`${reqNo} 凭原请求号续跑 → ${out.status}${out.reason && out.status !== '已预占' ? '：' + out.reason : ''}`)
    return out
  }

  function applyRelease(reqNo: string) {
    ledger.value = release(ledger.value, reqNo)
    flash(`${reqNo} 已撤回，容量腾让，队列自动重排`)
  }

  function applyVerify(key: string, verified: boolean) {
    const before = ledger.value
    ledger.value = verifyWindow(before, key, verified)
    flash(ledger.value === before ? '该窗口仍有排队/冲突，核对被拒绝' : `窗口核对${verified ? '通过' : '撤销'}`)
  }

  function applySignoff(stageId: string, unit: AgencyUnit, author: string, opinion: string) {
    ledger.value = addSignoff(ledger.value, { stageId, unit, author, opinion })
    flash(`${stageId}·${unit} 会签已锚定 F${ledger.value.fingerprint}`)
  }

  // 阶段时间变化：窗口改期，预占/会签/通告/核对全部失效重算
  function applyStageDateChange(newDate: string) {
    const oldWindows = ledger.value.windows
    const newWindows = buildWindows(newDate)
    const remap: Record<string, string> = {}
    oldWindows.forEach((oldW, i) => { remap[oldW.key] = newWindows[i].key })
    ledger.value = bumpInput(ledger.value, { stagesChanged: true, windows: newWindows, remap })
    selectedWindowKey.value = newWindows[0].key
    flash(`施工时间改为 ${newDate}：F${ledger.value.fingerprint}，预占重算、会签失效、通告草稿作废、核对清零`)
  }

  // 绕行变化：窗口容量参数重算（示例为容量 -1，模拟绕行吸纳能力下降）
  function applyDetourChange() {
    const current = ledger.value.windows
    const newWindows = current.map((w) => ({ ...w, capacity: Math.max(6, w.capacity - 1) }))
    ledger.value = bumpInput(ledger.value, { detoursChanged: true, windows: newWindows })
    flash(`绕行路线调整：路面可通行容量下降，F${ledger.value.fingerprint}，预占重算、会签失效、通告草稿作废、核对清零`)
  }

  return {
    ledger, lastMessage, selectedWindowKey,
    windows, requests, queuedCount, conflictCount, unverifiedCount,
    canPublish, blockedReasons, signoffs, fingerprint,
    applySubmit, applyConcurrent, applyRetry, applyRelease,
    applyVerify, applySignoff, applyStageDateChange, applyDetourChange,
  }
})
