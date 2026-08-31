import axios from 'axios'

const http = axios.create({
  baseURL: '',
  timeout: 30000,
})

// FAQ 管理
export const getFaqList = () => http.get('/api/faq').then(r => r.data)
export const getFaqDetail = (code) => http.get(`/api/faq/${code}`).then(r => r.data)
export const addFaq = (data) => http.post('/api/faq', data).then(r => r.data)
export const deleteFaq = (code) => http.delete(`/api/faq/${code}`).then(r => r.data)
export const updateFaqCategory = (code, categoryId) =>
  http.put(`/api/faq/${code}/category`, { categoryId }).then(r => r.data)

// 批量导入
export const importFaqJson = (faqs, defaultCategoryId) =>
  http.post('/api/faq/import', { faqs, defaultCategoryId }).then(r => r.data)
export const importFaqCsv = (csvText) =>
  http.post('/api/faq/import/csv', csvText, {
    headers: { 'Content-Type': 'text/csv' },
  }).then(r => r.data)
export const downloadTemplate = () => '/api/faq/template'
