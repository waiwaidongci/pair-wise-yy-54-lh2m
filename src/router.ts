import { createRouter, createWebHistory } from 'vue-router'
import OverviewView from './views/OverviewView.vue'
import MapView from './views/MapView.vue'
import ReviewView from './views/ReviewView.vue'

export default createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'overview', component: OverviewView },
    { path: '/map', name: 'map', component: MapView },
    { path: '/review', name: 'review', component: ReviewView },
  ],
})
