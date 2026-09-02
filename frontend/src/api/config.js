import http from '@/utils/http'

export const getConfig = () => http.get('/api/config').then(r => r.data)
export const saveConfig = (data) => http.post('/api/config', data).then(r => r.data)

// NER 类型管理
export const getNerTypes = () => http.get('/api/config/ner-types').then(r => r.data)
export const saveNerTypes = (types) => http.post('/api/config/ner-types', { types }).then(r => r.data)
export const testNerRegex = (text) => http.post('/api/config/ner-types/test', { text }).then(r => r.data)

// LLM 提示词管理
export const getLlmPrompts = () => http.get('/api/config/llm-prompts').then(r => r.data)
export const saveLlmPrompts = (prompts) => http.post('/api/config/llm-prompts', { prompts }).then(r => r.data)
