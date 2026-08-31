import axios from 'axios'

const http = axios.create({ baseURL: '', timeout: 15000 })

export const getStats = () => http.get('/api/stats').then(r => r.data)
