<template>
  <el-container style="height: 100vh">
    <!-- 侧边栏 -->
    <el-aside width="200px" class="sidebar">
      <div class="logo"> 智能体管理平台</div>
      <el-menu
        :default-active="activeMenu"
        router
        background-color="#1a1a2e"
        text-color="rgba(255,255,255,0.7)"
        active-text-color="#fff"
      >
        <el-menu-item v-for="item in menuItems" :key="item.path" :index="item.path">
          <el-icon><component :is="item.icon" /></el-icon>
          <span>{{ item.title }}</span>
        </el-menu-item>
        <el-menu-item index="/admin-legacy" @click.prevent="openChatPreview">
          <el-icon><ChatDotSquare /></el-icon>
          <span>聊天预览</span>
        </el-menu-item>
      </el-menu>
    </el-aside>

    <!-- 主内容区 -->
    <el-container>
      <el-header class="topbar">
        <h2>{{ currentTitle }}</h2>
        <div style="display:flex;gap:8px;align-items:center">
          <el-button size="small" @click="refresh" :icon="Refresh">刷新</el-button>
          <el-button size="small" type="danger" plain @click="handleLogout">退出</el-button>
        </div>
      </el-header>
      <el-main class="content">
        <router-view :key="route.fullPath" @refresh="onRefresh" />
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup>
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Refresh, ChatDotSquare } from '@element-plus/icons-vue'
import { logout } from '@/utils/auth'

const route = useRoute()
const router = useRouter()

const menuItems = [
  { path: '/', title: '概览', icon: 'DataLine' },
  { path: '/monitor', title: '服务监控', icon: 'Monitor' },
  { path: '/analysis', title: '智能分析', icon: 'TrendCharts' },
  { path: '/issues', title: '问题追踪', icon: 'Search' },
  { path: '/task-tracking', title: '任务管理', icon: 'List' },
  { path: '/faq', title: 'FAQ 管理', icon: 'Document' },
  { path: '/rules', title: '流程设计', icon: 'SetUp' },
  { path: '/config', title: '系统配置', icon: 'Setting' },
]

const activeMenu = computed(() => route.path)
const currentTitle = computed(() => {
  const item = menuItems.find(m => m.path === route.path)
  return item?.title || '智能体管理平台'
})

function refresh() {
  window.dispatchEvent(new CustomEvent('admin-refresh'))
}

function onRefresh() {
  // 子组件可通过 @refresh 事件通知父组件
}

function openChatPreview() {
  window.open('/', '_blank')
}

function handleLogout() {
  logout()
  router.push('/login')
}
</script>

<style scoped>
.sidebar {
  background: #1a1a2e;
  overflow-y: auto;
}
.sidebar .logo {
  padding: 20px;
  font-size: 16px;
  font-weight: 600;
  color: #fff;
  border-bottom: 1px solid rgba(255,255,255,.1);
}
.sidebar :deep(.el-menu) {
  border-right: none;
  padding: 12px 0;
}
.sidebar :deep(.el-menu-item) {
  transition: .2s;
}
.sidebar :deep(.el-menu-item:hover),
.sidebar :deep(.el-menu-item.is-active) {
  background: rgba(255,255,255,.1) !important;
}
.topbar {
  background: #fff;
  padding: 14px 24px;
  border-bottom: 1px solid #eee;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.topbar h2 {
  font-size: 16px;
  color: #333;
  margin: 0;
}
.content {
  background: #f0f2f5;
  overflow-y: auto;
  padding: 24px;
}
</style>
