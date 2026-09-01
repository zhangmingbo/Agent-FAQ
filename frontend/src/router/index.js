import { createRouter, createWebHashHistory } from 'vue-router'
import { isLoggedIn } from '@/utils/auth'

const routes = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/views/Login.vue'),
    meta: { title: '登录', public: true },
  },
  {
    path: '/',
    name: 'Dashboard',
    component: () => import('@/views/Dashboard.vue'),
    meta: { title: '概览', icon: 'DataLine' },
  },
  {
    path: '/monitor',
    name: 'Monitor',
    component: () => import('@/views/Monitor.vue'),
    meta: { title: '服务监控', icon: 'Monitor' },
  },
  {
    path: '/analysis',
    name: 'Analysis',
    component: () => import('@/views/Analysis.vue'),
    meta: { title: '智能分析', icon: 'TrendCharts' },
  },
  {
    path: '/issues',
    name: 'Issues',
    component: () => import('@/views/Issues.vue'),
    meta: { title: '问题追踪', icon: 'Search' },
  },
  {
    path: '/task-tracking',
    name: 'TaskTracking',
    component: () => import('@/views/TaskTracking.vue'),
    meta: { title: '任务管理', icon: 'List' },
  },
  {
    path: '/faq',
    name: 'FaqManage',
    component: () => import('@/views/FaqManage.vue'),
    meta: { title: 'FAQ 管理', icon: 'Document' },
  },
  {
    path: '/rules',
    name: 'Rules',
    component: () => import('@/views/Rules.vue'),
    meta: { title: '规则引擎', icon: 'SetUp' },
  },
  {
    path: '/config',
    name: 'SysConfig',
    component: () => import('@/views/SysConfig.vue'),
    meta: { title: '系统配置', icon: 'Setting' },
  },
]

const router = createRouter({
  history: createWebHashHistory(),
  routes,
})

// 路由守卫：未登录跳转登录页
router.beforeEach((to, from, next) => {
  if (!to.meta.public && !isLoggedIn()) {
    next('/login')
  } else {
    next()
  }
})

export default router
