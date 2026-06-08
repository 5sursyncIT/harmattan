import api from './dolibarr';

export const getContracts = (params = {}) => api.get('/contracts/list', { params });
export const getContract = (id) => api.get(`/contracts/${id}`);
export const createContract = (data) => api.post('/contracts', data);
export const updateContract = (id, data) => api.put(`/contracts/${id}`, data);
export const validateContract = (id) => api.post(`/contracts/${id}/validate`);
export const closeContract = (id) => api.post(`/contracts/${id}/close`);
export const reopenContract = (id) => api.post(`/contracts/${id}/reopen`);
export const getPendingIsbnContracts = () => api.get('/contracts/pending-isbn');
export const setContractIsbn = (id, book_isbn) => api.patch(`/contracts/${id}/isbn`, { book_isbn });
export const deleteContract = (id) => api.delete(`/contracts/${id}`);
export const getContractStats = () => api.get('/contracts/stats');
export const getExpiringContracts = (days = 90) => api.get('/contracts/expiring', { params: { days } });
export const downloadContractDocument = (id) => api.get(`/contracts/${id}/document`, { responseType: 'blob' });
export const exportContractsCsv = (params = {}) => api.get('/contracts/export/csv', { params, responseType: 'blob' });
export const searchAuthors = (q) => api.get('/contracts/thirdparties/search', { params: { q } });
export const createAuthor = (data) => api.post('/contracts/thirdparties', data);

// Signature
export const getSignatureUrl = (id) => api.get(`/contracts/${id}/signature-url`);
export const sendSignatureEmail = (id) => api.post(`/contracts/${id}/send-signature`);
export const getSignatureStatus = (id) => api.get(`/contracts/${id}/signature-status`);
export const signContractPhysical = (id, formData) => api.post(`/contracts/${id}/sign-physical`, formData, { headers: { 'Content-Type': 'multipart/form-data' } });
export const getSignedScan = (id) => api.get(`/contracts/${id}/signed-scan`, { responseType: 'blob' });
export const regenerateSignedContract = (id) => api.post(`/contracts/${id}/regenerate-signed`);
