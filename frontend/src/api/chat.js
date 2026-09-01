import http from '@/utils/http'

export const sendChat = (data) => http.post('/api/chat', data).then(r => r.data)
