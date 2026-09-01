import http from '@/utils/http'

// 任务实例跟踪
export const getTaskInstances = (params) =>
  http.get('/api/task-instances', { params }).then(r => r.data)
export const getTaskInstanceStats = () =>
  http.get('/api/task-instances/stats').then(r => r.data)
export const getTaskInstanceDetail = (id) =>
  http.get(`/api/task-instances/${id}`).then(r => r.data)
export const updateTaskInstance = (id, data) =>
  http.put(`/api/task-instances/${id}`, data).then(r => r.data)
export const deleteTaskInstance = (id) =>
  http.delete(`/api/task-instances/${id}`).then(r => r.data)
export const cancelTaskInstance = (id) =>
  http.post(`/api/task-instances/${id}/cancel`).then(r => r.data)
