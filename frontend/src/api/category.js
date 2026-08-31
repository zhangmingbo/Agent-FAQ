import axios from 'axios'

const http = axios.create({ baseURL: '', timeout: 15000 })

export const getCategories = () => http.get('/api/categories').then(r => r.data)
export const getCategoryFaqs = (id) => http.get(`/api/categories/${id}/faqs`).then(r => r.data)
export const addCategory = (data) => http.post('/api/categories', data).then(r => r.data)
export const deleteCategory = (id) => http.delete(`/api/categories/${id}`).then(r => r.data)
