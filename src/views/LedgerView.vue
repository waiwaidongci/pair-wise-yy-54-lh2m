<script setup lang="ts">
import { computed, ref } from 'vue'
import { useLedgerStore } from '../store/ledger'
import type { AgencyUnit } from '../ledger/engine'

const store = useLedgerStore()

const form = ref({ client: '', amount: 2, source: '' })
const concurrentForm = ref({
  clientA: '施工员A', sourceA: '护栏移位 (ST-02)', amountA: 2,
  clientB: '施工员B', sourceB: '标线划设 (ST-02)', amountB: 2,
})
const newDate = ref('2026-10-27')

const signForm = ref({ unit: '交警' as AgencyUnit, author: '', opinion: '' })
const signUnits: AgencyUnit[] = ['交警', '公交', '急救', '建设']

const selectedWindow = computed(() => store.windows.find((w) => w.key === store.selectedWindowKey) ?? store.windows[0])
const windowRequests = computed(() => store.requests.filter((r) => r.windowKey === selectedWindow.value?.key))
const remain = computed(() => (selectedWindow.value ? selectedWindow.value.capacity - selectedWindow.value.used : 0))

function statusColor(status: string) {
  return status === '已预占' ? 'green' : status === '排队中' ? 'orange' : 'red'
}

function submitOne() {
  if (!form.value.client.trim() || !form.value.source.trim()) return
  store.applySubmit({
    client: form.value.client.trim(),
    amount: Number(form.value.amount),
    source: form.value.source.trim(),
    windowKey: selectedWindow.value!.key,
  })
  form.value = { client: '', amount: 2, source: '' }
}

function submitBoth() {
  store.applyConcurrent(
    { client: concurrentForm.value.clientA, amount: Number(concurrentForm.value.amountA), source: concurrentForm.value.sourceA, windowKey: selectedWindow.value!.key },
    { client: concurrentForm.value.clientB, amount: Number(concurrentForm.value.amountB), source: concurrentForm.value.sourceB, windowKey: selectedWindow.value!.key },
  )
}

function sign() {
  if (!signForm.value.author.trim() || !signForm.value.opinion.trim()) return
  store.applySignoff('ST-02', signForm.value.unit, signForm.value.author.trim(), signForm.value.opinion.trim())
  signForm.value.author = ''
  signForm.value.opinion = ''
}

function signState(unit: AgencyUnit) {
  return store.signoffs.find((s) => s.stageId === 'ST-02' && s.unit === unit)
}

function exportNotice() {
  if (!store.canPublish || store.ledger.notice.state !== 'ready') return
  const blob = new Blob([store.ledger.notice.text], { type: 'text/plain;charset=utf-8' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = `通行通告-F${store.fingerprint}.txt`
  link.click()
  URL.revokeObjectURL(link.href)
}
</script>

<template>
  <section class="page-head compact">
    <div>
      <p class="eyebrow">通行账 · 急救 / 公交保底 · 施工预占</p>
      <h1>半小时窗口通行账</h1>
      <p>急救与公交最低班次先留额度，施工申请只吃剩余容量；超额排队标明占用来源。输入版本 F{{ store.fingerprint }}。</p>
    </div>
    <a-space>
      <a-button status="warning" @click="store.applyDetourChange()">模拟绕行调整（容量−1）</a-button>
      <span class="inline-actions">
        <a-date-picker v-model="newDate" value-format="YYYY-MM-DD" style="width:150px" />
        <a-button type="primary" @click="store.applyStageDateChange(newDate)">改期并重算</a-button>
      </span>
    </a-space>
  </section>

  <a-alert type="info" class="mb16" :title="`最近动作：${store.lastMessage}`" />

  <div class="metrics">
    <article class="card metric"><span>排队申请</span><strong :class="{ hot: store.queuedCount }">{{ store.queuedCount }}</strong><small>超额未占容量</small></article>
    <article class="card metric"><span>首写冲突</span><strong :class="{ hot: store.conflictCount }">{{ store.conflictCount }}</strong><small>后到留冲突待续跑</small></article>
    <article class="card metric"><span>未核对窗口</span><strong :class="{ hot: store.unverifiedCount }">{{ store.unverifiedCount }}</strong><small>清零前不出通告</small></article>
    <article class="card metric"><span>输入版本</span><strong>F{{ store.fingerprint }}</strong><small>时间/绕行一变即+1</small></article>
  </div>

  <div class="ledger-grid">
    <article class="card">
      <div class="panel-head">
        <div><h2>半小时窗口额度</h2><p>绿条为已用（含急救/公交保底），灰条为剩余</p></div>
        <a-tag color="red">急救 3 班 / 公交 2 班保底</a-tag>
      </div>
      <button v-for="w in store.windows" :key="w.key" class="window" :class="{ active: selectedWindow?.key === w.key, verified: w.verified }" @click="store.selectedWindowKey = w.key">
        <div class="window-top"><b>{{ w.label.split('·')[1] }}</b><span>{{ w.used }}/{{ w.capacity }}</span><a-tag v-if="w.verified" color="green" size="small">已核对</a-tag></div>
        <div class="bar"><i class="res-em" :style="{ width: (w.reserve.emergency / w.capacity * 100) + '%' }"></i><i class="res-bus" :style="{ width: (w.reserve.transit / w.capacity * 100) + '%' }"></i><i class="work" :style="{ width: ((w.used - w.reserve.emergency - w.reserve.transit) / w.capacity * 100) + '%' }"></i></div>
        <div class="legend"><span><i class="dot em"></i>急救 {{ w.reserve.emergency }}</span><span><i class="dot bus"></i>公交 {{ w.reserve.transit }}</span><span><i class="dot wk"></i>施工 {{ Math.max(0, w.used - w.reserve.emergency - w.reserve.transit) }}</span><span>余 {{ w.capacity - w.used }}</span></div>
      </button>
    </article>

    <div class="right-col">
      <article class="card" v-if="selectedWindow">
        <div class="panel-head"><div><h2>{{ selectedWindow.label }}</h2><p>容量 {{ selectedWindow.capacity }}｜已用 {{ selectedWindow.used }}｜剩余 {{ remain }}</p></div><a-button size="small" :type="selectedWindow.verified ? 'outline' : 'primary'" @click="store.applyVerify(selectedWindow.key, !selectedWindow.verified)">{{ selectedWindow.verified ? '撤销核对' : '核对窗口' }}</a-button></div>
        <div class="sources">
          <div v-for="(s, i) in selectedWindow.sources" :key="i" class="src" :class="s.kind">
            <a-tag size="small" :color="s.kind === '急救保留' ? 'red' : s.kind === '公交保留' ? 'arcoblue' : 'green'">{{ s.kind }}</a-tag>
            <span v-if="s.kind === '施工预占'"><b>{{ s.reqNo }}</b> · {{ s.client }} · {{ store.requests.find(r => r.reqNo === s.reqNo)?.source }}</span>
            <span v-else>最低班次保留额度</span>
            <em>×{{ s.amount }}</em>
          </div>
        </div>
        <h3>该窗口申请（{{ windowRequests.length }}）</h3>
        <div v-if="!windowRequests.length" class="empty">暂无施工申请</div>
        <div v-for="r in windowRequests" :key="r.reqNo" class="req" :class="r.status">
          <div class="req-head"><b>{{ r.reqNo }}</b><a-tag :color="statusColor(r.status)" size="small">{{ r.status }}</a-tag><span class="who">{{ r.client }}</span></div>
          <p>{{ r.source }}｜需 {{ r.amount }}</p>
          <small v-if="r.blockReason" class="reason">占用来源：{{ r.blockReason }}</small>
          <div class="req-actions">
            <a-button size="mini" type="outline" :disabled="r.status === '已预占'" @click="store.applyRetry(r.reqNo)">按原号 {{ r.reqNo }} 续跑</a-button>
            <a-button size="mini" status="danger" type="text" @click="store.applyRelease(r.reqNo)">撤回腾让</a-button>
          </div>
        </div>
      </article>
    </div>
  </div>

  <div class="grid-3 mt16">
    <article class="card">
      <h2>顺序提交施工申请</h2>
      <p class="hint">按剩余容量预占，放不下自动排队；同号提交幂等不重扣。</p>
      <a-form :model="form" layout="vertical">
        <a-form-item label="提交人/单位"><a-input v-model="form.client" placeholder="如：照明分包" /></a-form-item>
        <a-form-item label="占用来源（阶段）"><a-input v-model="form.source" placeholder="如：路灯迁改 (ST-02)" /></a-form-item>
        <a-form-item label="占用班次数"><a-input-number v-model="form.amount" :min="1" :max="10" /></a-form-item>
        <a-button type="primary" long @click="submitOne">提交到当前窗口</a-button>
      </a-form>
    </article>

    <article class="card">
      <h2>两人同时提交（首写）</h2>
      <p class="hint">同窗口同一回合：先到首写生效，后到留冲突、不扣额度，凭原号续跑。</p>
      <div class="race">
        <div class="racer"><b>甲方</b><a-input v-model="concurrentForm.clientA" size="small" /><a-input v-model="concurrentForm.sourceA" size="small" placeholder="占用来源" /><a-input-number v-model="concurrentForm.amountA" :min="1" size="small" /></div>
        <div class="vs">VS</div>
        <div class="racer"><b>乙方</b><a-input v-model="concurrentForm.clientB" size="small" /><a-input v-model="concurrentForm.sourceB" size="small" placeholder="占用来源" /><a-input-number v-model="concurrentForm.amountB" :min="1" size="small" /></div>
      </div>
      <a-button type="primary" status="warning" long class="mt10" @click="submitBoth">同窗口同时提交</a-button>
    </article>

    <article class="card">
      <h2>四方会签（ST-02）</h2>
      <p class="hint">会签锚定 F{{ store.fingerprint }}；时间或绕行一变即全部失效需重签。</p>
      <div class="sign-grid">
        <div v-for="u in signUnits" :key="u" class="sign-chip" :class="{ invalid: signState(u)?.status === '失效', valid: signState(u)?.status === '有效' && signState(u)?.fingerprint === store.fingerprint }">
          <b>{{ u }}</b>
          <small v-if="signState(u)">{{ signState(u)!.author }} · {{ signState(u)!.status === '失效' || signState(u)!.fingerprint !== store.fingerprint ? '已失效' : 'F' + signState(u)!.fingerprint }}</small>
          <small v-else>未签</small>
        </div>
      </div>
      <a-form :model="signForm" layout="vertical" class="mt10">
        <a-select v-model="signForm.unit"><a-option v-for="u in signUnits" :key="u" :value="u">{{ u }}</a-option></a-select>
        <a-input v-model="signForm.author" placeholder="签署人" class="mt10" />
        <a-textarea v-model="signForm.opinion" placeholder="会签意见/条件" class="mt10" />
        <a-button long class="mt10" @click="sign">提交会签</a-button>
      </a-form>
    </article>
  </div>

  <article class="card mt16">
    <div class="panel-head">
      <div><h2>公开通告</h2><p>闸门：排队/冲突清零、窗口全部核对、四方会签齐备且锚定当前指纹，方可出具</p></div>
      <a-button type="primary" :disabled="!store.canPublish" @click="exportNotice">出具并下载通告</a-button>
    </div>
    <a-alert v-if="!store.canPublish" type="error" title="通告暂不可出具，未核对窗口清零前拦截" class="mb16">
      <ul class="reasons"><li v-for="(r, i) in store.blockedReasons" :key="i">{{ r }}</li></ul>
    </a-alert>
    <pre v-else class="notice-text">{{ store.ledger.notice.state === 'ready' ? store.ledger.notice.text : '' }}</pre>
  </article>

  <article class="card mt16">
    <div class="panel-head"><div><h2>审计流水</h2><p>预占、续跑、失效重算全程留痕</p></div></div>
    <div class="log"><div v-for="(line, i) in [...store.ledger.log].reverse()" :key="i">{{ line }}</div></div>
  </article>
</template>

<style scoped>
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:16px}
.inline-actions{display:inline-flex;gap:8px}
.metric{padding:17px;border-left:4px solid #2563eb}.metric span,.metric small{display:block;color:#667085}.metric strong{display:block;font-size:29px;margin:7px 0 2px}.metric strong.hot{color:#e11d48}
.ledger-grid{display:grid;grid-template-columns:1.15fr 1fr;gap:16px}.right-col{display:grid;gap:16px;align-content:start}
.panel-head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px}.panel-head h2{font-size:17px;margin:0 0 4px}.panel-head p{color:#7a8798;font-size:12px;margin:0}
.window{display:block;width:100%;text-align:left;border:1px solid #e7ebf1;border-radius:8px;padding:12px;margin-bottom:10px;background:#fff;cursor:pointer}.window:hover,.window.active{border-color:#2563eb;background:#f5f8ff}.window.verified{border-left:3px solid #16a34a}
.window-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}.window-top span{color:#475569;font-size:13px}
.bar{display:flex;height:10px;border-radius:5px;overflow:hidden;background:#eef2f6}.bar i{display:block;height:100%}.res-em{background:#e11d48}.res-bus{background:#2563eb}.work{background:#16a34a}
.legend{display:flex;gap:14px;margin-top:7px;font-size:12px;color:#667085}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px}.dot.em{background:#e11d48}.dot.bus{background:#2563eb}.dot.wk{background:#16a34a}
.sources{display:grid;gap:6px;margin-bottom:12px}.src{display:flex;align-items:center;gap:8px;font-size:13px;padding:6px 8px;border-radius:6px;background:#f8fafc}.src em{margin-left:auto;font-style:normal;color:#475569}.src.急救保留{background:#fff1f2}.src.公交保留{background:#eff6ff}
h3{font-size:14px;margin:14px 0 8px}.empty{color:#98a2b3;font-size:13px}
.req{border:1px solid #edf0f5;border-radius:7px;padding:10px;margin-bottom:8px}.req.排队中{border-left:3px solid #f59e0b;background:#fffbeb}.req.冲突{border-left:3px solid #e11d48;background:#fff1f2}.req.已预占{border-left:3px solid #16a34a;background:#f6fef9}
.req-head{display:flex;align-items:center;gap:8px}.req-head .who{color:#7a8798;font-size:12px;margin-left:auto}.req p{margin:6px 0 2px;font-size:13px;color:#475569}.reason{display:block;color:#b42318;font-size:12px;margin-bottom:6px}.req-actions{display:flex;gap:8px;margin-top:4px}
.grid-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px}.card h2{font-size:16px;margin:0 0 4px}.hint{color:#7a8798;font-size:12px;margin:0 0 12px}.mt10{margin-top:10px}
.race{display:grid;grid-template-columns:1fr auto 1fr;gap:10px;align-items:start}.racer{display:grid;gap:6px;border:1px dashed #d0d5dd;border-radius:7px;padding:9px}.racer b{font-size:13px}.vs{align-self:center;color:#98a2b3;font-weight:800;font-size:12px}
.sign-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.sign-chip{border:1px solid #e7ebf1;border-radius:7px;padding:9px}.sign-chip b,.sign-chip small{display:block}.sign-chip small{color:#7a8798;margin-top:3px}.sign-chip.valid{border-color:#16a34a;background:#f6fef9}.sign-chip.invalid{border-color:#e11d48;background:#fff1f2}
.reasons{margin:6px 0 0;padding-left:18px}.reasons li{font-size:13px;margin:2px 0}.notice-text{background:#0f172a;color:#d1fae5;padding:14px;border-radius:8px;font-size:12.5px;line-height:1.7;white-space:pre-wrap;margin:0}
.log{max-height:190px;overflow:auto;font-size:12px;color:#475569;background:#f8fafc;border-radius:7px;padding:10px}.log div{padding:2px 0;border-bottom:1px dashed #e7ebf1}
@media(max-width:1100px){.ledger-grid,.grid-3{grid-template-columns:1fr}.metrics{grid-template-columns:1fr 1fr}}
</style>
