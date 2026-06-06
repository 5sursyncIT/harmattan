import api from './dolibarr';

export const listContractQuotes = (contractId) => api.get(`/contracts/${contractId}/quotes`);
export const createContractQuote = (contractId, data) => api.post(`/contracts/${contractId}/quotes`, data);
export const getQuote = (id) => api.get(`/quotes/${id}`);
export const markQuoteSent = (id) => api.post(`/quotes/${id}/send`);
export const deleteQuote = (id) => api.delete(`/quotes/${id}`);
export const getQuoteDefaults = (params) => api.get('/quotes/defaults', { params });

export const downloadQuotePdf = async (quote) => {
  const res = await api.get(`/quotes/${quote.id}/pdf`, { responseType: 'blob' });
  const url = URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${quote.ref}.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export const openQuotePdf = (id) => {
  // Opens in new tab; CSRF/cookie carried by browser
  window.open(`/api/quotes/${id}/pdf`, '_blank', 'noopener,noreferrer');
};
