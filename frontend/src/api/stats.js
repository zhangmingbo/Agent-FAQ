import http from '@/utils/http'

export const getStats = () => http.get('/api/stats').then(r => r.data)
