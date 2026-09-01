import http from '@/utils/http'

// 问题追踪
export const getUnmatched = (params) =>
  http.get('/api/chat-log/unmatched', { params }).then(r => r.data)
export const getLowConfidence = (params) =>
  http.get('/api/chat-log/low-confidence', { params }).then(r => r.data)
export const getChatLogDates = (type) =>
  http.get('/api/chat-log/dates', { params: { type } }).then(r => r.data)
export const getRecentRecords = (params) =>
  http.get('/api/chat-log/recent', { params }).then(r => r.data)
export const getRecentDates = () =>
  http.get('/api/chat-log/dates', { params: { type: 'recent' } }).then(r => r.data)
export const getLiveLogs = (params) =>
  http.get('/api/chat-log/live', { params }).then(r => r.data)
