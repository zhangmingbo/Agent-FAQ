import axios from 'axios'

const http = axios.create({ baseURL: '', timeout: 30000 })

export const getAnalysis = () => http.get('/api/analysis').then(r => r.data)
export const getSuggest = (text) => http.post('/api/analysis/suggest', { text }).then(r => r.data)
export const addQuestion = (faqCode, question) =>
  http.post('/api/analysis/add-question', { faqCode, question }).then(r => r.data)
export const checkQuestions = (texts) =>
  http.post('/api/analysis/check-questions', { texts }).then(r => r.data)
