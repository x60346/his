import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import './style.css'

// 順序：pinia 必須先於 router，因為路由守衛會用到 auth store
createApp(App).use(createPinia()).use(router).mount('#app')
