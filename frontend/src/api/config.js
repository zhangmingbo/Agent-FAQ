import axios from 'axios'

const http = axios.create({ baseURL: '', timeout: 15000 })

export const getConfig = () => http.get('/api/config').then(r => r.data)
export const saveConfig = (data) => http.post('/api/config', data).then(r => r.data)
