export type StageStatus = '待协商' | '条件通过' | '已批准' | '退回'

export interface ClosureStage {
  id: string
  name: string
  start: string
  end: string
  lanes: string
  status: StageStatus
  route: [number, number][]
}

export interface DetourRoute {
  id: string
  name: string
  distance: number
  extraMinutes: number
  coordinates: [number, number][]
}

export interface SegmentComment {
  id: string
  segmentId: string
  unit: '建设' | '交通' | '公交' | '应急'
  author: string
  content: string
  condition?: string
  status: '待处理' | '已接受' | '已退回'
}

export interface Scheme {
  id: string
  project: string
  contractor: string
  area: string
  version: number
  stages: ClosureStage[]
  detours: DetourRoute[]
  comments: SegmentComment[]
}

// ─────────────────────────────────────────────────────────────
// 通行账 (Traffic Ledger)
// 把施工阶段、绕行路线、会签意见和通告接成一本按半小时窗口
// 分配路面额度的账：急救/公交留最低班次额度，施工按剩余容量
// 预占，超额排队并标明占用来源；时间或绕行一变就失效重算。
// ─────────────────────────────────────────────────────────────

export type OccupationSource = '急救' | '公交' | '施工' | '交警'
export type WindowStatus = '待核对' | '已核对'
export type OccupationStatus = '预占' | '已确认' | '失效' | '已撤销'
export type QueueStatus = '排队中' | '已分配' | '失效'
export type TicketStatus = '成功' | '冲突' | '排队' | '失败' | '已撤销'
export type CountersignStatus = '有效' | '待重新会签' | '已失效'
export type NoticeStatus = '草稿' | '已失效' | '已发布'

/** 半小时窗口：一天按运营时段切成若干窗口，每窗口有总容量与急救/公交预留额度。 */
export interface WindowSlot {
  id: string
  date: string        // YYYY-MM-DD
  start: string       // HH:mm
  end: string         // HH:mm
  capacity: number
  reservedEmergency: number
  reservedBus: number
  version: number     // 乐观并发版本：首写生效，后到留冲突
  status: WindowStatus
}

/** 预占/占用：施工或交警按剩余容量预占的额度。 */
export interface Occupation {
  id: string
  windowId: string
  source: OccupationSource
  requestNo: string
  amount: number
  stageId?: string
  detourId?: string
  status: OccupationStatus
  baseVersion: number
  layoutVersion: number
  createdAt: number
}

/** 排队项：超额部分排队，并标明占用来源（急救/公交预留）。 */
export interface QueueItem {
  id: string
  windowId: string
  requestNo: string
  source: OccupationSource
  amount: number
  stageId?: string
  reason: string          // 占用来源说明
  status: QueueStatus
  layoutVersion: number
  occupationId?: string   // 分配后对应的预占记录
  createdAt: number
}

/** 冲突记录：两人同时提交同一窗口，首写生效，后到留冲突。 */
export interface ConflictRecord {
  id: string
  windowId: string
  requestNo: string
  source: OccupationSource
  amount: number
  baseVersion: number
  currentVersion: number
  reason: string
  createdAt: number
}

/** 请求号票据：按请求号幂等续跑，失败后按原请求号重试，不重复扣额度。 */
export interface RequestTicket {
  requestNo: string
  windowId: string
  source: OccupationSource
  amount: number
  status: TicketStatus
  occupationId?: string
  queueId?: string
  conflictId?: string
  attempts: number
  lastError?: string
  createdAt: number
}

/** 会签意见：锚定 layout 版本，时间或绕行一变就待重新会签。 */
export interface Countersign {
  id: string
  unit: '建设' | '交通' | '公交' | '应急'
  author: string
  stageId: string
  opinion: string
  layoutVersion: number
  status: CountersignStatus
  createdAt: number
}

/** 通告草稿：锚定 layout 版本，未核对窗口清零前不得发布。 */
export interface NoticeDraft {
  id: string
  version: number
  status: NoticeStatus
  content: string
  layoutVersion: number
  createdAt: number
  publishedAt?: number
}

/** 原始申请：用于失效重算后按原请求号重跑。 */
export interface ApplicationRequest {
  requestNo: string
  windowId: string
  source: OccupationSource
  amount: number
  stageId?: string
  detourId?: string
}
