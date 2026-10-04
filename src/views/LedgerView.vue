<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useLedgerStore } from '../store/ledger'
import { useSchemeStore } from '../store/scheme'
import type { OccupationSource } from '../types'

const ledger = useLedgerStore()
const scheme = useSchemeStore()
const { selectedDate, lastMessage } = storeToRefs(ledger)

const selectedWindowId = ref('')
const applySource = ref<OccupationSource>('施工')
const applyAmount = ref(2)
const countersignUnit = ref<'建设' | '交通' | '公交' | '应急'>('交通')
const countersignAuthor = ref('')
const countersignStageId = ref('ST-01')
const countersignOpinion = ref('')
const applyForm = reactive({ source: applySource, amount: applyAmount })
const csForm = reactive({ unit: countersignUnit, author: countersignAuthor, stageId: countersignStageId, opinion: countersignOpinion })

const selectedWindow = computed(() => ledger.windows.find((w) => w.id === selectedWindowId.value))
const selectedOccupations = computed(() => ledger.occupations.filter((o) => o.windowId === selectedWindowId.value && o.status === '预占'))
const selectedQueue = computed(() => ledger.queue.filter((q) => q.windowId === selectedWindowId.value && q.status === '排队中'))
const selectedConflicts = computed(() => ledger.windowConflicts(selectedWindowId.value))

const dateOptions = computed(() => ledger.dates.map((d) => ({ label: d, value: d })))

function pickWindow(windowId: string) {
  selectedWindowId.value = windowId
}

function apply() {
  if (!selectedWindow.value) return
  const requestNo = ledger.nextRequestNo()
  ledger.submitApplication({
    requestNo, windowId: selectedWindow.value.id, source: applySource.value,
    amount: applyAmount.value, baseVersion: selectedWindow.value.version,
  })
}

function retry(requestNo: string) {
  ledger.retryTicket(requestNo)
}

function withdrawOcc(occupationId: string) {
  ledger.withdrawOccupation(occupationId)
}
function withdrawQ(queueId: string) {
  ledger.withdrawQueue(queueId)
}

function addCountersign() {
  if (!countersignAuthor.value.trim() || !countersignOpinion.value.trim()) return
  ledger.addCountersign(countersignUnit.value, countersignAuthor.value, countersignStageId.value, countersignOpinion.value)
  countersignOpinion.value = ''
}

function saveDraft() { ledger.saveNoticeDraft() }
function publish() {
  const r = ledger.publishNotice()
  if (!r.ok) return
}
function download() { ledger.downloadNotice() }

function cellColor(windowId: string) {
  return ledger.utilizationColor(windowId)
}
function cellPct(windowId: string) {
  return Math.round(ledger.utilization(windowId) * 100)
}
</script>

<template>
  <section class="page-head compact">
    <div>
      <p class="eyebrow">施工 · 交警 · 公交 · 应急 通行账</p>
      <h1>窗口额度分配通行账</h1>
      <p>急救与公交按最低班次留额度，施工按剩余容量预占，超额排队并标明占用来源；时间或绕行一变即失效重算。</p>
    </div>
    <a-space>
      <a-button @click="ledger.recalculate">失效重算</a-button>
      <a-button @click="saveDraft">保存通告草稿</a-button>
      <a-button type="primary" :disabled="!ledger.canPublishNotice" @click="publish">发布通告</a-button>
    </a-space>
  </section>

  <a-alert v-if="lastMessage" type="info" class="mb16" :title="lastMessage" />

  <div class="metrics">
    <article class="card metric"><span>窗口总数</span><strong>{{ ledger.windows.length }}</strong><small>layout v{{ ledger.layoutVersion }}</small></article>
    <article class="card metric"><span>已核对窗口</span><strong>{{ ledger.verifiedCount }}/{{ ledger.windows.length }}</strong><small>清零后方可发布通告</small></article>
    <article class="card metric"><span>排队项</span><strong :class="{ warn: ledger.pendingQueueCount > 0 }">{{ ledger.pendingQueueCount }}</strong><small>超额部分排队</small></article>
    <article class="card metric"><span>冲突记录</span><strong :class="{ warn: ledger.pendingConflictCount > 0 }">{{ ledger.pendingConflictCount }}</strong><small>首写生效 · 后到留冲突</small></article>
  </div>

  <div class="grid-ledger">
    <!-- 窗口热力图 -->
    <article class="card heatmap-card">
      <div class="panel-head">
        <div><h2>半小时窗口容量热力图</h2><p>按施工阶段日期展开，颜色越深占用越高；点击窗口查看额度并申请</p></div>
        <a-select v-model="selectedDate" :options="dateOptions" style="width:170px" />
      </div>
      <div class="heatmap-scroll">
        <div class="heatmap">
          <div class="hm-row hm-head">
            <div class="hm-date">日期</div>
            <div v-for="slot in ledger.timeSlots" :key="slot.start" class="hm-cell hm-time">{{ slot.start }}</div>
          </div>
          <div v-for="date in ledger.dates" :key="date" class="hm-row">
            <div class="hm-date">{{ date }}</div>
            <div
              v-for="slot in ledger.timeSlots"
              :key="slot.start"
              class="hm-cell hm-slot"
              :class="{ active: selectedWindowId === `W-${date}-${slot.start}`, cleared: ledger.isCleared(`W-${date}-${slot.start}`) }"
              :style="{ background: cellColor(`W-${date}-${slot.start}`), opacity: 0.25 + 0.7 * ledger.utilization(`W-${date}-${slot.start}`) }"
              :title="`${date} ${slot.start}–${slot.end}｜${cellPct(`W-${date}-${slot.start}`)}%`"
              @click="pickWindow(`W-${date}-${slot.start}`)"
            >
              <span class="hm-pct">{{ cellPct(`W-${date}-${slot.start}`) }}%</span>
            </div>
          </div>
        </div>
      </div>
      <div class="legend">
        <span><i style="background:#16a34a" />充足</span>
        <span><i style="background:#f59e0b" />接近上限</span>
        <span><i style="background:#e11d48" />占满/超额</span>
      </div>
    </article>

    <!-- 窗口明细与申请 -->
    <article class="card detail-card">
      <div class="panel-head">
        <div><h2>窗口额度明细</h2><p v-if="selectedWindow">{{ selectedWindow.date }} {{ selectedWindow.start }}–{{ selectedWindow.end }} · 版本 v{{ selectedWindow.version }}</p><p v-else>请选择一个窗口</p></div>
        <a-tag v-if="selectedWindow" :color="ledger.isCleared(selectedWindow.id) ? 'green' : 'orange'">{{ ledger.isCleared(selectedWindow.id) ? '已核对清零' : '待核对' }}</a-tag>
      </div>

      <template v-if="selectedWindow">
        <div class="cap-bar">
          <div class="cap-seg emergency" :style="{ width: (selectedWindow.reservedEmergency / selectedWindow.capacity * 100) + '%' }">急救 {{ selectedWindow.reservedEmergency }}</div>
          <div class="cap-seg bus" :style="{ width: (selectedWindow.reservedBus / selectedWindow.capacity * 100) + '%' }">公交 {{ selectedWindow.reservedBus }}</div>
          <div class="cap-seg construction" :style="{ width: (ledger.occupiedBySource(selectedWindow.id).施工 / selectedWindow.capacity * 100) + '%' }">施工 {{ ledger.occupiedBySource(selectedWindow.id).施工 }}</div>
          <div class="cap-seg police" :style="{ width: (ledger.occupiedBySource(selectedWindow.id).交警 / selectedWindow.capacity * 100) + '%' }">交警 {{ ledger.occupiedBySource(selectedWindow.id).交警 }}</div>
          <div class="cap-seg free" :style="{ width: (ledger.remainingCapacity(selectedWindow.id) / selectedWindow.capacity * 100) + '%' }">剩余 {{ ledger.remainingCapacity(selectedWindow.id) }}</div>
        </div>
        <p class="cap-note">容量 {{ selectedWindow.capacity }} ＝ 急救预留 {{ selectedWindow.reservedEmergency }} ＋ 公交预留 {{ selectedWindow.reservedBus }} ＋ 施工/交警预占 ＋ 剩余 {{ ledger.remainingCapacity(selectedWindow.id) }}</p>

        <div class="apply-form">
          <a-form layout="inline" :model="applyForm">
            <a-form-item label="来源">
              <a-select v-model="applySource" style="width:110px">
                <a-option value="施工">施工</a-option>
                <a-option value="交警">交警</a-option>
              </a-select>
            </a-form-item>
            <a-form-item label="额度">
              <a-input-number v-model="applyAmount" :min="1" :max="selectedWindow.capacity" style="width:90px" />
            </a-form-item>
            <a-form-item>
              <a-button type="primary" @click="apply">按剩余容量申请</a-button>
            </a-form-item>
          </a-form>
          <a-button size="mini" @click="ledger.simulateConcurrentSubmit(selectedWindow.id)">模拟两人同时提交同一窗口</a-button>
        </div>

        <h3>已预占</h3>
        <div v-for="occ in selectedOccupations" :key="occ.id" class="occ-row">
          <a-tag :color="occ.source === '施工' ? 'blue' : 'purple'">{{ occ.source }}</a-tag>
          <b>{{ occ.requestNo }}</b>
          <span>占用 {{ occ.amount }}</span>
          <a-tag color="green">{{ occ.status }}</a-tag>
          <a-button size="mini" status="danger" @click="withdrawOcc(occ.id)">撤销</a-button>
        </div>
        <div v-if="selectedOccupations.length === 0" class="empty">暂无预占</div>

        <h3>排队（超额）</h3>
        <div v-for="q in selectedQueue" :key="q.id" class="queue-row">
          <a-tag color="orange">{{ q.source }}</a-tag>
          <b>{{ q.requestNo }}</b>
          <span>排队 {{ q.amount }}</span>
          <p class="occ-source">占用来源：{{ q.reason }}</p>
          <a-button size="mini" status="danger" @click="withdrawQ(q.id)">撤销</a-button>
        </div>
        <div v-if="selectedQueue.length === 0" class="empty">暂无排队</div>

        <h3>冲突</h3>
        <div v-for="c in selectedConflicts" :key="c.id" class="conflict-row">
          <a-tag color="red">{{ c.requestNo }}</a-tag>
          <span>base v{{ c.baseVersion }} → 当前 v{{ c.currentVersion }}</span>
          <p>{{ c.reason }}</p>
        </div>
        <div v-if="selectedConflicts.length === 0" class="empty">暂无冲突</div>
      </template>
      <div v-else class="empty">请在左侧热力图选择一个窗口</div>
    </article>
  </div>

  <div class="grid-2 mt16">
    <!-- 请求号票据 -->
    <article class="card">
      <div class="panel-head"><div><h2>请求号票据与幂等续跑</h2><p>失败后按原请求号续跑，不重复扣额度</p></div><a-tag color="blue">{{ ledger.tickets.length }} 笔</a-tag></div>
      <div class="ticket-list">
        <div v-for="t in [...ledger.tickets].reverse()" :key="t.requestNo" class="ticket" :class="t.status">
          <div class="ticket-head">
            <b>{{ t.requestNo }}</b>
            <a-tag :color="t.status === '成功' ? 'green' : t.status === '排队' ? 'orange' : t.status === '冲突' ? 'red' : t.status === '失败' ? 'red' : 'gray'">{{ t.status }}</a-tag>
            <small>第 {{ t.attempts }} 次</small>
          </div>
          <p>{{ t.source }} · {{ t.windowId }} · 额度 {{ t.amount }}</p>
          <p v-if="t.lastError" class="err">{{ t.lastError }}</p>
          <a-button v-if="t.status === '失败' || t.status === '冲突'" size="mini" type="primary" @click="retry(t.requestNo)">按原请求号续跑</a-button>
        </div>
      </div>
    </article>

    <!-- 会签 -->
    <article class="card">
      <div class="panel-head"><div><h2>会签意见</h2><p>锚定 layout 版本，时间或绕行一变即待重新会签</p></div><a-tag color="orange">{{ ledger.countersigns.filter(c => c.status === '待重新会签').length }} 待重新会签</a-tag></div>
      <div class="countersign-list">
        <div v-for="c in [...ledger.countersigns].reverse()" :key="c.id" class="countersign" :class="c.status">
          <div class="cs-head"><a-tag :color="c.unit === '交通' ? 'blue' : c.unit === '公交' ? 'orange' : c.unit === '应急' ? 'red' : 'cyan'">{{ c.unit }}</a-tag><b>{{ c.author }}</b><a-tag :color="c.status === '有效' ? 'green' : 'orange'">{{ c.status }}</a-tag><small>layout v{{ c.layoutVersion }}</small></div>
          <p>{{ c.opinion }}</p><em>锚点 {{ c.stageId }}</em>
        </div>
      </div>
      <a-divider />
      <div class="cs-form">
        <a-form layout="vertical" :model="csForm">
          <a-form-item label="单位">
            <a-select v-model="countersignUnit"><a-option value="建设">建设</a-option><a-option value="交通">交通</a-option><a-option value="公交">公交</a-option><a-option value="应急">应急</a-option></a-select>
          </a-form-item>
          <a-form-item label="会签人"><a-input v-model="countersignAuthor" placeholder="姓名" /></a-form-item>
          <a-form-item label="锚定阶段">
            <a-select v-model="countersignStageId">
              <a-option v-for="s in scheme.scheme.stages" :key="s.id" :value="s.id">{{ s.id }} · {{ s.name }}</a-option>
            </a-select>
          </a-form-item>
          <a-form-item label="意见"><a-textarea v-model="countersignOpinion" placeholder="会签意见" /></a-form-item>
          <a-button type="primary" @click="addCountersign">登记会签</a-button>
        </a-form>
      </div>
    </article>
  </div>

  <!-- 通告 -->
  <article class="card mt16">
    <div class="panel-head">
      <div><h2>公开通告</h2><p>未核对窗口清零前不出通告；时间或绕行变更后草稿失效</p></div>
      <a-space>
        <a-tag v-if="ledger.noticeDrafts.length" color="blue">草稿 v{{ ledger.noticeDrafts[ledger.noticeDrafts.length - 1].version }}</a-tag>
        <a-tag v-if="ledger.noticeDrafts[ledger.noticeDrafts.length - 1]?.status === '已发布'" color="green">已发布</a-tag>
        <a-button @click="saveDraft">保存草稿</a-button>
        <a-button @click="download">下载</a-button>
        <a-button type="primary" :disabled="!ledger.canPublishNotice" @click="publish">发布通告</a-button>
      </a-space>
    </div>
    <div v-if="ledger.noticeDrafts.length" class="notice-preview">
      <pre>{{ ledger.noticeDrafts[ledger.noticeDrafts.length - 1].content }}</pre>
    </div>
    <a-alert v-else type="warning" title="暂无通告草稿" />
    <a-alert v-if="!ledger.canPublishNotice" type="warning" class="mt16" title="仍有窗口未核对清零（排队或冲突未解决），暂不出通告" />
  </article>
</template>

<style scoped>
.page-head.compact{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:14px}
.page-head h1{font-size:24px;margin:4px 0 7px}
.page-head p{margin:0;color:#667085;font-size:13px}
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:16px}
.metric{padding:15px;border-left:4px solid #2563eb}
.metric span,.metric small{display:block;color:#667085}
.metric strong{display:block;font-size:26px;margin:6px 0 2px}
.metric strong.warn{color:#e11d48}
.grid-ledger{display:grid;grid-template-columns:1.5fr 1fr;gap:16px}
.panel-head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px}
.panel-head h2{font-size:16px;margin:0 0 3px}
.panel-head p{color:#7a8798;font-size:12px;margin:0}
.heatmap-scroll{overflow:auto;border:1px solid #edf0f5;border-radius:6px}
.heatmap{min-width:720px}
.hm-row{display:flex;align-items:stretch}
.hm-row.hm-head{position:sticky;top:0;background:#f8fafc;z-index:2}
.hm-date{width:92px;flex-shrink:0;font-size:11px;color:#475569;padding:4px 6px;display:flex;align-items:center;border-bottom:1px solid #edf0f5}
.hm-cell{flex:1;min-width:26px;height:24px;border-bottom:1px solid #f1f5f9;border-right:1px solid #f1f5f9;cursor:pointer;position:relative}
.hm-cell.hm-time{font-size:10px;color:#64748b;display:flex;align-items:center;justify-content:center;cursor:default;background:#f8fafc}
.hm-slot:hover{outline:2px solid #2563eb;outline-offset:-2px}
.hm-slot.active{outline:2px solid #1d4ed8;outline-offset:-2px}
.hm-slot.cleared::after{content:'';position:absolute;top:2px;right:2px;width:6px;height:6px;border-radius:50%;background:#16a34a}
.hm-pct{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:9px;color:#0f172a;opacity:.75;pointer-events:none}
.legend{display:flex;gap:16px;margin-top:10px;font-size:12px;color:#64748b}
.legend span{display:flex;align-items:center;gap:6px}
.legend i{width:12px;height:12px;border-radius:3px;display:inline-block}
.detail-card{height:fit-content}
.cap-bar{display:flex;height:26px;border-radius:6px;overflow:hidden;margin:8px 0;font-size:11px;color:#fff}
.cap-seg{display:flex;align-items:center;justify-content:center;white-space:nowrap;overflow:hidden}
.cap-seg.emergency{background:#e11d48}
.cap-seg.bus{background:#d97706}
.cap-seg.construction{background:#2563eb}
.cap-seg.police{background:#7c3aed}
.cap-seg.free{background:#cbd5e1;color:#475569}
.cap-note{font-size:11px;color:#64748b;margin:0 0 10px}
.apply-form{padding:10px;background:#f8fafc;border-radius:6px;margin-bottom:12px}
.apply-form :deep(.arco-form-item){margin-bottom:6px}
.detail-card h3{font-size:13px;margin:14px 0 8px;color:#334155}
.occ-row,.queue-row,.conflict-row{display:flex;align-items:center;gap:8px;padding:8px;border:1px solid #edf0f5;border-radius:6px;margin-bottom:6px;flex-wrap:wrap}
.occ-row b,.queue-row b{font-size:13px}
.occ-row span,.queue-row span{font-size:12px;color:#475569}
.occ-source{width:100%;margin:2px 0 0;font-size:11px;color:#b45309}
.conflict-row{background:#fef2f2;border-color:#fecaca}
.conflict-row p{width:100%;margin:2px 0 0;font-size:11px;color:#991b1b}
.empty{font-size:12px;color:#94a3b8;padding:6px 0}
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.ticket-list,.countersign-list{max-height:360px;overflow:auto}
.ticket{padding:10px;border:1px solid #edf0f5;border-radius:6px;margin-bottom:8px}
.ticket.成功{border-left:3px solid #16a34a}
.ticket.排队{border-left:3px solid #f59e0b}
.ticket.冲突,.ticket.失败{border-left:3px solid #e11d48}
.ticket.已撤销{border-left:3px solid #94a3b8;opacity:.7}
.ticket-head{display:flex;align-items:center;gap:8px;margin-bottom:4px}
.ticket-head b{font-size:13px;flex:1}
.ticket-head small{color:#94a3b8;font-size:11px}
.ticket p{margin:2px 0;font-size:12px;color:#475569}
.ticket .err{color:#e11d48;font-size:11px}
.countersign{padding:10px;border:1px solid #edf0f5;border-radius:6px;margin-bottom:8px}
.countersign.待重新会签{border-left:3px solid #f59e0b;background:#fffbeb}
.cs-head{display:flex;align-items:center;gap:8px;margin-bottom:4px}
.cs-head b{font-size:13px;flex:1}
.cs-head small{color:#94a3b8;font-size:11px}
.countersign p{margin:2px 0;font-size:12px;color:#475569}
.countersign em{font-size:11px;color:#94a3b8;font-style:normal}
.cs-form :deep(.arco-form-item){margin-bottom:10px}
.notice-preview{background:#f8fafc;border:1px solid #edf0f5;border-radius:6px;padding:14px;max-height:360px;overflow:auto}
.notice-preview pre{margin:0;white-space:pre-wrap;font-family:inherit;font-size:13px;color:#334155}
.mt16{margin-top:16px}
.mb16{margin-bottom:16px}
@media(max-width:1100px){.grid-ledger{grid-template-columns:1fr}.grid-2{grid-template-columns:1fr}.metrics{grid-template-columns:repeat(2,1fr)}}
</style>
