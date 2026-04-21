import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
});

let csrfToken = null;
async function ensureCsrf() {
  if (!csrfToken) {
    try {
      const res = await api.get('/csrf-token');
      csrfToken = res.data.csrfToken;
    } catch (err) { console.warn('CSRF token fetch failed:', err); }
  }
  return csrfToken;
}

api.interceptors.request.use(async (config) => {
  const method = config.method?.toLowerCase();
  if (['post', 'put', 'delete'].includes(method)) {
    const token = await ensureCsrf();
    if (token) config.headers['X-CSRF-Token'] = token;
  }
  return config;
});

export const authorApi = {
  register: (data) => api.post('/author/register', data),
  login: (email, password) => api.post('/author/login', { email, password }),
  logout: () => api.post('/author/logout'),
  me: () => api.get('/author/me'),
  forgotPassword: (email) => api.post('/author/forgot-password', { email }),
  resetPassword: (payload) => api.post('/author/reset-password', payload),
  updateProfile: (data) => api.put('/author/profile', data),
  updatePassword: (currentPassword, newPassword) =>
    api.put('/author/password', { currentPassword, newPassword }),
  // Manuscrits
  submitManuscript: (formData) =>
    api.post('/author/manuscripts', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }),
  listManuscripts: () => api.get('/author/manuscripts'),
  getManuscript: (id) => api.get(`/author/manuscripts/${id}`),
  downloadFile: (manuscriptId, fileId) =>
    `/api/author/manuscripts/${manuscriptId}/files/${fileId}/download`,
  validateCorrection: (id, decision, comment) =>
    api.post(`/author/manuscripts/${id}/validate-correction`, { decision, comment }),
  validateBat: (id, decision, comment) =>
    api.post(`/author/manuscripts/${id}/validate-bat`, { decision, comment }),
};
