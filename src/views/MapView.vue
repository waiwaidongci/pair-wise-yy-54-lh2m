<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import maplibregl, { Map as MapLibreMap } from 'maplibre-gl'
import { useSchemeStore } from '../store/scheme'

const store = useSchemeStore()
const mapEl = ref<HTMLDivElement>()
let map: MapLibreMap | undefined
const layers = ref({ closure: true, detour: true, ambulance: true, bus: true, adjacent: true })

function addGeoSource(id: string, coordinates: [number, number][], color: string, dasharray?: number[]) {
  if (!map?.isStyleLoaded()) return
  if (map.getLayer(id)) { map.removeLayer(id); map.removeSource(id) }
  map.addSource(id, { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } } })
  map.addLayer({ id, type: 'line', source: id, paint: { 'line-color': color, 'line-width': 5, 'line-opacity': .85, ...(dasharray ? { 'line-dasharray': dasharray } : {}) } })
}

function drawAll() {
  if (!map?.isStyleLoaded()) return
  const stage = store.selectedStage
  if (stage) addGeoSource('closure', stage.route, '#ef4444')
  store.scheme.detours.forEach((route, index) => addGeoSource(`detour-${index}`, route.coordinates, '#2563eb', [2, 2]))
  addGeoSource('ambulance', [[121.476,31.216],[121.478,31.228],[121.496,31.235]], '#16a34a')
  addGeoSource('bus', [[121.466,31.220],[121.480,31.229],[121.502,31.238]], '#d97706', [1, 1])
  addGeoSource('adjacent', [[121.502,31.244],[121.514,31.236],[121.524,31.228]], '#7c3aed')
}
function toggleLayer(id: string, visible: boolean) { if (map?.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none') }
function fit() { const bounds = new maplibregl.LngLatBounds(); store.scheme.stages.flatMap((stage) => stage.route).forEach((point) => bounds.extend(point)); map?.fitBounds(bounds, { padding: 60 }) }
function getStageFromMap() { return store.selectedStage }
onMounted(async () => {
  await nextTick()
  map = new maplibregl.Map({
    container: mapEl.value!,
    style: { version: 8, sources: { osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, attribution: '© OpenStreetMap' } }, layers: [{ id: 'osm', type: 'raster', source: 'osm' }] },
    center: [121.488, 31.23], zoom: 13,
  })
  map.addControl(new maplibregl.NavigationControl(), 'top-right')
  map.on('load', drawAll)
  map.on('click', (event) => store.addPoint([event.lngLat.lng, event.lngLat.lat]))
})
onBeforeUnmount(() => map?.remove())
watch(() => store.selectedStageId, () => { if (!map) return; const stage = getStageFromMap(); if (stage) { map.flyTo({ center: stage.route[0], zoom: 14 }); drawAll() } })
watch(layers, () => {
  if (!map) return
  toggleLayer('closure', layers.value.closure)
  store.scheme.detours.forEach((_, index) => toggleLayer(`detour-${index}`, layers.value.detour))
  toggleLayer('ambulance', layers.value.ambulance)
  toggleLayer('bus', layers.value.bus)
  toggleLayer('adjacent', layers.value.adjacent)
}, { deep: true })
</script>

<template>
  <section class="page-head compact"><div><p class="eyebrow">几何与时间联动</p><h1>封路范围与阶段地图</h1><p>选择阶段后在地图上点击绘制路线；每次几何修改都会生成版本，审批意见锚定对应路段。</p></div><a-space><a-button @click="store.startDraw" :status="store.drawing ? 'danger' : undefined">{{ store.drawing ? `绘制中 · 已点 ${store.draftRoute.length} 个` : '绘制封路路线' }}</a-button><a-button :disabled="!store.drawing" type="primary" @click="store.finishDraw">完成绘制</a-button><a-button @click="fit">定位全段</a-button></a-space></section>
  <div class="toolbar card"><a-radio-group v-model="store.selectedStageId" type="button"><a-radio v-for="stage in store.scheme.stages" :key="stage.id" :value="stage.id">{{ stage.id }}</a-radio></a-radio-group><span class="spacer"></span><a-checkbox v-model="layers.closure">封路</a-checkbox><a-checkbox v-model="layers.detour">绕行</a-checkbox><a-checkbox v-model="layers.ambulance">救护通道</a-checkbox><a-checkbox v-model="layers.bus">公交</a-checkbox><a-checkbox v-model="layers.adjacent">相邻工程</a-checkbox></div>
  <div class="map-grid">
    <div ref="mapEl" class="map"></div>
    <aside class="card inspector">
      <div class="panel-head"><div><h2>{{ store.selectedStage?.name }}</h2><p>{{ store.selectedStage?.start }} → {{ store.selectedStage?.end }}</p></div><a-tag :color="store.selectedStage?.status === '退回' ? 'red' : 'orange'">{{ store.selectedStage?.status }}</a-tag></div>
      <a-form layout="vertical" :model="store.selectedStage || {}">
        <a-form-item label="车道占用"><a-input :model-value="store.selectedStage?.lanes" @change="(value: string) => store.updateStage({ lanes: value })" /></a-form-item>
        <a-form-item label="阶段名称"><a-input :model-value="store.selectedStage?.name" @change="(value: string) => store.updateStage({ name: value })" /></a-form-item>
        <div class="two"><a-form-item label="开始"><a-date-picker :model-value="store.selectedStage?.start" @change="(value: any) => store.updateStage({ start: value })" /></a-form-item><a-form-item label="结束"><a-date-picker :model-value="store.selectedStage?.end" @change="(value: any) => store.updateStage({ end: value })" /></a-form-item></div>
      </a-form>
      <h3>绕行比较</h3>
      <div v-for="route in store.scheme.detours" :key="route.id" class="detour"><div><b>{{ route.name }}</b><small>{{ route.distance }} km · 增加 {{ route.extraMinutes }} 分钟</small></div><a-tag :color="route.extraMinutes > 10 ? 'orange' : 'green'">{{ route.extraMinutes > 10 ? '关注' : '可用' }}</a-tag></div>
      <a-divider />
      <h3>路段冲突</h3>
      <div v-for="item in store.conflicts.filter((conflict) => conflict.segmentId === store.selectedStageId)" :key="item.id" class="issue" :class="item.level === '高' ? 'red' : 'amber'"><b>{{ item.title }}</b><p>{{ item.detail }}</p></div>
    </aside>
  </div>
</template>

<style scoped>
.toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px;margin-bottom:14px}.spacer{flex:1}.map-grid{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(330px,.65fr);gap:16px}.map{height:min(68vh,680px);min-height:420px;border-radius:8px;overflow:hidden}.inspector{height:fit-content}.panel-head{display:flex;justify-content:space-between}.panel-head h2{font-size:18px;margin:0 0 5px}.panel-head p{color:#7a8798;font-size:12px;margin:0}.two{display:grid;grid-template-columns:1fr 1fr;gap:8px}.inspector h3{font-size:14px;margin:18px 0 10px}.detour{display:flex;justify-content:space-between;gap:10px;padding:10px 0;border-bottom:1px solid #edf0f5}.detour b,.detour small{display:block}.detour small{color:#7a8798;margin-top:4px}.issue{padding:10px;border-radius:6px;margin-bottom:8px}.issue.red{background:#fff1f2}.issue.amber{background:#fff7ed}.issue p{margin:4px 0 0;color:#64748b;font-size:13px}
@media(max-width:1050px){.map-grid{grid-template-columns:1fr}.map{height:55vh}}
</style>
