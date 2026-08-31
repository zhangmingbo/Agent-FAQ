import axios from 'axios'

const http = axios.create({ baseURL: '', timeout: 60000 })

export const sendChat = (data) => http.post('/api/chat', data).then(r => r.data)
