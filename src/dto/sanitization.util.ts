export function sanitizeString(value: unknown): string {
  if (typeof value !== 'string') return value as string;
  return value
    .trim()
    .replace(/\0/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\$/g, '')
    .replace(/\s{2,}/g, ' ');
}

export function sanitizeSlug(value: unknown): string {
  if (typeof value !== 'string') return value as string;
  return value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
}

export function sanitizeEmail(value: unknown): string {
  if (typeof value !== 'string') return value as string;
  return value.trim().toLowerCase();
}
