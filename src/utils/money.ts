export function money(value: number | string | bigint) {
  const n = typeof value === 'bigint' ? Number(value) : Number(value);
  return `$${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 }).format(n)}`;
}
