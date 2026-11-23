export function join(...parts: string[]) {
  return parts.filter(Boolean).join('/');
}
export function resolve(...parts: string[]) {
  return parts.filter(Boolean).join('/');
}
export function basename(p: string) {
  return (p || '').split(/[\\/]/).pop() || '';
}
export function dirname(p: string) {
  return (p || '').split(/[\\/]/).slice(0, -1).join('/') || '.';
}
export function extname(p: string) {
  const base = basename(p);
  const idx = base.lastIndexOf('.');
  return idx !== -1 ? base.slice(idx) : '';
}
export default {
  join,
  resolve,
  basename,
  dirname,
  extname,
};

