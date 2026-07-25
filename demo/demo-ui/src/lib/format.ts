export const currency = (n: number, opts?: { compact?: boolean }): string => {
  if (opts?.compact && Math.abs(n) >= 1000) {
    return `$${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`;
  }
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: n % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
};

export const relativeDate = (iso: string): string => {
  const d = new Date(iso);
  const diff = Math.round((d.getTime() - Date.now()) / 86400000);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (Math.abs(diff) < 1) {
    const h = Math.round((d.getTime() - Date.now()) / 3600000);
    if (Math.abs(h) < 1) return 'just now';
    return rtf.format(h, 'hour');
  }
  if (Math.abs(diff) < 30) return rtf.format(diff, 'day');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

export const shortDate = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export const dateTime = (iso: string): string =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export const initials = (name: string): string =>
  name
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
