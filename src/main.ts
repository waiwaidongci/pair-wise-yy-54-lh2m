import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ArcoVue from '@arco-design/web-vue'
import '@arco-design/web-vue/dist/arco.css'
import 'maplibre-gl/dist/maplibre-gl.css'
import { provideApolloClient } from '@vue/apollo-composable'
import App from './App.vue'
import router from './router'
import { apolloClient } from './graphql'
import './styles.css'

provideApolloClient(apolloClient)
createApp(App).use(createPinia()).use(router).use(ArcoVue).mount('#app')
