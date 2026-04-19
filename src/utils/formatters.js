export const formatPrice = (price) => {
  const num = parseFloat(price) || 0;
  return new Intl.NumberFormat('fr-FR', {
    style: 'decimal',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(Math.round(num)) + ' FCFA';
};

export const truncateText = (text, maxLength = 150) => {
  if (!text || text.length <= maxLength) return text || '';
  return text.substring(0, maxLength).trim() + '...';
};

export function stripHtml(html) {
  if (!html) return '';
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  let text = tmp.textContent || tmp.innerText || '';
  // Remove publishing metadata block starting with "Date de publication"
  text = text.replace(/\s*Date de publication\s*:[\s\S]*$/i, '');
  // Remove Amazon-style metadata (Publisher/Éditeur, Language, ISBN-10, ISBN-13, etc.)
  text = text.replace(/\s*(Publisher|Éditeur)\s*[\u200f\u200e‏‎:].[\s\S]*$/i, '');
  // Remove trailing standalone ISBN/EAN lines
  text = text.replace(/\s*ISBN\s*:\s*[\d\s-]+[\s\S]*$/i, '');
  return text.trim();
}

export const slugify = (text) => {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
};
