import http from '@/utils/http'

export const getConfig = () => http.get('/api/config').then(r => r.data)
export const saveConfig = (data) => http.post('/api/config', data).then(r => r.data)
