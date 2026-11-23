export function existsSync() {
  return false;
}
export function readFileSync() {
  return '';
}
export function writeFileSync() {}
export function statSync() {
  return { size: 0, isDirectory: () => false };
}
export default {
  existsSync,
  readFileSync,
  writeFileSync,
  statSync,
};

