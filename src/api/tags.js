import api from './dolibarr';

// ── Admin : CRUD tags ──────────────────────────────────────
export const listTags = () => api.get('/admin/tags');
export const createTag = (data) => api.post('/admin/tags', data);
export const updateTag = (id, data) => api.put(`/admin/tags/${id}`, data);
export const deleteTag = (id) => api.delete(`/admin/tags/${id}`);
export const getTagProducts = (slug, params = {}) =>
  api.get(`/admin/tags/${slug}/products`, { params });

// ── Admin : assignment livre <-> tags ──────────────────────
export const getBookTags = (bookId) => api.get(`/admin/books/${bookId}/tags`);
export const setBookTags = (bookId, tags) => api.put(`/admin/books/${bookId}/tags`, tags);

// ── Public (home) ──────────────────────────────────────────
export const getHomeTags = () => api.get('/home/tags');
export const getHomeTagProducts = (slug, limit) =>
  api.get(`/home/tags/${slug}/products`, { params: limit ? { limit } : {} });
