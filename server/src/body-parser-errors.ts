/**
 * Convert body-parser's documented client errors into a stable public shape.
 *
 * Only known body-parser error types with a 4xx status are accepted. This
 * keeps parser failures from becoming noisy 500s without trusting arbitrary
 * application errors that happen to carry a `status` field.
 */
const CLIENT_ERROR_TYPES = new Set([
  'charset.unsupported',
  'encoding.unsupported',
  'entity.parse.failed',
  'entity.too.large',
  'entity.verify.failed',
  'parameters.too.many',
  'request.aborted',
  'request.size.invalid',
])

export function publicBodyParserError(err: unknown): { status: number; message: string } | null {
  if (!err || typeof err !== 'object') return null
  const candidate = err as { type?: unknown; status?: unknown; statusCode?: unknown }
  if (typeof candidate.type !== 'string' || !CLIENT_ERROR_TYPES.has(candidate.type)) return null
  const status = candidate.status ?? candidate.statusCode
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 400 || status > 499) {
    return null
  }
  if (status === 413) return { status, message: 'request entity too large' }
  if (status === 415) return { status, message: 'unsupported request encoding' }
  if (candidate.type === 'entity.parse.failed') return { status, message: 'invalid JSON body' }
  return { status, message: 'invalid request body' }
}
