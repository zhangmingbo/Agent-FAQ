import http from '@/utils/http'

export const uploadFile = (filename, data, type) =>
  http.post('/api/upload', { filename, data, type }).then(r => r.data)
export const getUploads = () => http.get('/api/uploads').then(r => r.data)
export const deleteUpload = (name) => http.delete(`/api/uploads/${name}`).then(r => r.data)
