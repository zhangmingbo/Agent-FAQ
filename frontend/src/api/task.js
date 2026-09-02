import http from '@/utils/http'

// 任务定义 CRUD
export const getTasks = () => http.get('/api/tasks').then(r => r.data)
export const getTaskDetail = (code) => http.get(`/api/tasks/${code}`).then(r => r.data)
export const saveTask = (data) => http.post('/api/tasks', data).then(r => r.data)
export const deleteTask = (code) => http.delete(`/api/tasks/${code}`).then(r => r.data)
export const toggleTask = (code, status) => http.post(`/api/tasks/${code}/toggle`, { status }).then(r => r.data)
export const getTaskSuggestions = (limit) => http.get('/api/tasks/suggestions', { params: { limit } }).then(r => r.data)
