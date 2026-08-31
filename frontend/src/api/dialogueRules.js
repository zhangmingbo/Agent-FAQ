import axios from 'axios'

const http = axios.create({ baseURL: '', timeout: 15000 })

export const getDialogueRules = () => http.get('/api/dialogue-rules').then(r => r.data)
export const saveDialogueRules = (data) => http.post('/api/dialogue-rules', data).then(r => r.data)
export const resetDialogueRules = () => http.post('/api/dialogue-rules/reset').then(r => r.data)
export const exportDialogueRules = () => '/api/dialogue-rules/export'
export const getRuleStats = () => http.get('/api/dialogue-rules/stats').then(r => r.data)
export const resetRuleStats = () => http.post('/api/dialogue-rules/stats/reset').then(r => r.data)
export const getRuleLogs = (params) => http.get('/api/dialogue-rules/logs', { params }).then(r => r.data)
export const clearRuleLogs = () => http.post('/api/dialogue-rules/logs/clear').then(r => r.data)
