import axios from 'axios'

const http = axios.create({ baseURL: '', timeout: 15000 })

// 任务实例跟踪
export const getTaskInstances = (params) =>
  http.get('/api/task-instances', { params }).then(r => r.data)
export const getTaskInstanceStats = () =>
  http.get('/api/task-instances/stats').then(r => r.data)
export const getTaskInstanceDetail = (id) =>
  http.get(`/api/task-instances/${id}`).then(r => r.data)
