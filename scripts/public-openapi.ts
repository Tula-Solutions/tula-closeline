// Builds `public-openapi.json`: the routes an API key may call, merged from each service's
// `openapi.json`. A route is public when its operation carries `x-closeline-public: true` and
// `x-closeline-scopes: ['<area>:read|write']` (ADR 0023). Usage:
//   bun scripts/public-openapi.ts                  build from the sibling clones, write the file
//   bun scripts/public-openapi.ts --check [file]   fail if the document has an unmarked route
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** Any JSON value. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** An OpenAPI document as far as this script reads it. */
export interface OpenapiDoc {
  [key: string]: Json | undefined
  openapi?: string
  info?: Record<string, Json>
  paths?: Record<string, Json>
  components?: Record<string, Json>
  webhooks?: Record<string, Json>
}

/** The extension that marks an operation as part of the public API. */
export const PUBLIC_MARK = 'x-closeline-public'
/** The extension that names the one API key scope an operation needs. */
export const SCOPES_MARK = 'x-closeline-scopes'
/** The security scheme every public operation must accept. */
export const TOKEN_SCHEME = 'accessToken'

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const
const SCOPE_PATTERN = /^[a-z][a-z0-9_]*:(read|write)$/
const SERVICES = ['auth', 'core', 'playbook', 'voice', 'outbound'] as const

type Obj = { [key: string]: Json }

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sortKeys(value: Json): Json {
  if (Array.isArray(value)) {
    return value.map(sortKeys)
  }
  if (isObj(value)) {
    const out: Obj = {}
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys(value[key] as Json)
    }
    return out
  }
  return value
}

function canonical(value: Json): string {
  return JSON.stringify(sortKeys(value))
}

/** Writes a document the one canonical way: fixed top-level order, every deeper key sorted, two-space indent, final newline. */
export function serialise(doc: OpenapiDoc): string {
  const out: Obj = {}
  for (const key of ['openapi', 'info', 'paths', 'components']) {
    const value = doc[key]
    if (value !== undefined) {
      out[key] = sortKeys(value)
    }
  }
  for (const key of Object.keys(doc).sort()) {
    const value = doc[key]
    if (!(key in out) && value !== undefined) {
      out[key] = sortKeys(value)
    }
  }
  return `${JSON.stringify(out, null, 2)}\n`
}

/** What is wrong with the marking of one operation; `requireMark` is true when an unmarked one is itself the problem. */
function operationProblems(
  method: string,
  path: string,
  operation: Json,
  requireMark: boolean
): string[] {
  const label = `${method.toUpperCase()} ${path}`
  if (!isObj(operation)) {
    return [`${label}: not an operation object`]
  }
  const mark = operation[PUBLIC_MARK]
  const scopes = operation[SCOPES_MARK]
  if (mark !== undefined && typeof mark !== 'boolean') {
    return [`${label}: ${PUBLIC_MARK} must be true or false`]
  }
  if (mark !== true) {
    if (requireMark) {
      return [`${label}: not marked public (${PUBLIC_MARK}: true)`]
    }
    return scopes === undefined ? [] : [`${label}: has ${SCOPES_MARK} but is not marked public`]
  }
  const problems: string[] = []
  if (!path.startsWith('/v1/') || path.split('/').includes('..')) {
    problems.push(`${label}: a public route must be a /v1 path`)
  }
  if (
    !Array.isArray(scopes) ||
    scopes.length !== 1 ||
    typeof scopes[0] !== 'string' ||
    !SCOPE_PATTERN.test(scopes[0])
  ) {
    problems.push(
      `${label}: a public route needs exactly one scope in ${SCOPES_MARK}, <area>:read or <area>:write`
    )
  } else {
    const kind = scopes[0].split(':')[1]
    const expected = method === 'get' ? 'read' : 'write'
    if (kind !== expected) {
      problems.push(`${label}: ${method.toUpperCase()} needs a ${expected} scope, not ${scopes[0]}`)
    }
  }
  const security = operation.security
  const takesToken =
    Array.isArray(security) && security.some((entry) => isObj(entry) && TOKEN_SCHEME in entry)
  if (!takesToken) {
    problems.push(`${label}: a public route must accept the ${TOKEN_SCHEME} security scheme`)
  }
  return problems
}

function collectRefs(value: Json, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRefs(item, into)
    }
  } else if (isObj(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (key === '$ref' && typeof item === 'string') {
        into.add(item)
      } else {
        collectRefs(item, into)
      }
    }
  }
}

function parseRef(ref: string): { kind: string; name: string } | undefined {
  const match = /^#\/components\/([A-Za-z]+)\/([^/]+)$/.exec(ref)
  return match?.[1] !== undefined && match[2] !== undefined
    ? { kind: match[1], name: match[2] }
    : undefined
}

/** Structural problems that would make the document an invalid OpenAPI 3.1 file; empty when none. */
export function validateOpenapi(doc: OpenapiDoc): string[] {
  const problems: string[] = []
  if (typeof doc.openapi !== 'string' || !doc.openapi.startsWith('3.1.')) {
    problems.push('openapi must be a 3.1.x version')
  }
  const info = doc.info
  if (!isObj(info) || typeof info.title !== 'string' || typeof info.version !== 'string') {
    problems.push('info needs a title and a version')
  }
  if (doc.paths === undefined && doc.components === undefined && doc.webhooks === undefined) {
    problems.push('the document needs paths, components or webhooks')
  }
  const refs = new Set<string>()
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    if (!path.startsWith('/') || !isObj(item)) {
      problems.push(`${path}: a path must start with / and hold an object`)
      continue
    }
    collectRefs(item, refs)
    for (const method of METHODS) {
      const operation = item[method]
      if (operation === undefined) {
        continue
      }
      if (!isObj(operation) || !isObj(operation.responses)) {
        problems.push(`${method.toUpperCase()} ${path}: needs a responses object`)
      }
    }
  }
  const components = doc.components ?? {}
  collectRefs(components as Json, refs)
  for (const ref of refs) {
    const parsed = parseRef(ref)
    const group = parsed === undefined ? undefined : components[parsed.kind]
    if (parsed === undefined || !isObj(group) || !(parsed.name in group)) {
      problems.push(`${ref}: reference does not resolve`)
    }
  }
  return problems
}

/** The CI check: valid OpenAPI 3.1, and every operation marked public with a scope on a /v1 path. */
export function checkPublicOpenapi(doc: OpenapiDoc): string[] {
  const problems = validateOpenapi(doc)
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    if (!isObj(item)) {
      continue
    }
    for (const method of METHODS) {
      const operation = item[method]
      if (operation !== undefined) {
        problems.push(...operationProblems(method, path, operation, true))
      }
    }
    for (const key of Object.keys(item)) {
      if (
        !(METHODS as readonly string[]).includes(key) &&
        key !== 'parameters' &&
        key !== 'summary' &&
        key !== 'description'
      ) {
        problems.push(`${path}: unexpected key ${key}`)
      }
    }
  }
  return problems
}

function addComponent(into: Obj, kind: string, name: string, value: Json): void {
  const group = (isObj(into[kind]) ? into[kind] : {}) as Obj
  into[kind] = group
  const existing = group[name]
  if (existing !== undefined && canonical(existing) !== canonical(value)) {
    throw new Error(`components.${kind}.${name} is defined differently by two services`)
  }
  group[name] = value
}

/**
 * Merges the operations marked public in each service's document into one OpenAPI 3.1 document.
 * Throws on a marked route without a valid scope, a route listed twice, a component two services
 * define differently or a reference that does not resolve. Core is required. The result does not
 * depend on the order of the services or of the keys.
 */
export function buildPublicOpenapi(services: Record<string, OpenapiDoc>): OpenapiDoc {
  if (services.core === undefined) {
    throw new Error('the core service document is required')
  }
  const paths: Obj = {}
  const components: Obj = {}
  const problems: string[] = []
  for (const name of Object.keys(services).sort()) {
    const doc = services[name] as OpenapiDoc
    const serviceComponents = isObj(doc.components) ? (doc.components as Obj) : {}
    const refs = new Set<string>()
    const schemes = new Set<string>()
    for (const [path, item] of Object.entries(doc.paths ?? {})) {
      if (!isObj(item)) {
        continue
      }
      const kept: Obj = {}
      for (const method of METHODS) {
        const operation = item[method]
        if (operation === undefined) {
          continue
        }
        const found = operationProblems(method, path, operation, false)
        problems.push(...found.map((message) => `${name}: ${message}`))
        if (found.length > 0 || !isObj(operation) || operation[PUBLIC_MARK] !== true) {
          continue
        }
        if (isObj(paths[path]) && method in (paths[path] as Obj)) {
          throw new Error(
            `${method.toUpperCase()} ${path} is public in two services (${name} and another) twice`
          )
        }
        kept[method] = operation
        collectRefs(operation, refs)
        for (const entry of (operation.security as Json[]) ?? []) {
          for (const scheme of isObj(entry) ? Object.keys(entry) : []) {
            schemes.add(scheme)
          }
        }
      }
      if (Object.keys(kept).length === 0) {
        continue
      }
      for (const [key, value] of Object.entries(item)) {
        if (!(METHODS as readonly string[]).includes(key)) {
          kept[key] = value
          collectRefs(value, refs)
        }
      }
      const target = (isObj(paths[path]) ? paths[path] : {}) as Obj
      paths[path] = target
      for (const [key, value] of Object.entries(kept)) {
        if (key in target && canonical(target[key] as Json) !== canonical(value)) {
          throw new Error(`${path}: ${key} differs between services`)
        }
        target[key] = value
      }
    }
    // Follow references to a fixed point, so a component reached only through another is kept.
    const done = new Set<string>()
    for (let todo = [...refs]; todo.length > 0; todo = [...refs].filter((ref) => !done.has(ref))) {
      for (const ref of todo) {
        done.add(ref)
        const parsed = parseRef(ref)
        const group = parsed === undefined ? undefined : serviceComponents[parsed.kind]
        if (parsed === undefined || !isObj(group) || group[parsed.name] === undefined) {
          throw new Error(`${name}: ${ref} does not resolve to a component`)
        }
        const value = group[parsed.name] as Json
        addComponent(components, parsed.kind, parsed.name, value)
        collectRefs(value, refs)
      }
    }
    for (const scheme of schemes) {
      const group = serviceComponents.securitySchemes
      if (!isObj(group) || group[scheme] === undefined) {
        throw new Error(`${name}: security scheme ${scheme} is not defined`)
      }
      addComponent(components, 'securitySchemes', scheme, group[scheme] as Json)
    }
  }
  if (problems.length > 0) {
    throw new Error(`public routes are not valid:\n${problems.join('\n')}`)
  }
  const out: OpenapiDoc = {
    openapi: '3.1.0',
    info: {
      title: 'Closeline public API',
      version: '1.0.0',
      description:
        'The routes an Organization API key may call. Exchange the key for a short-lived token at the auth service, then send it as a bearer token.',
    },
    paths: sortKeys(paths) as Record<string, Json>,
  }
  if (Object.keys(components).length > 0) {
    out.components = sortKeys(components) as Record<string, Json>
  }
  return out
}

function readDoc(file: string): OpenapiDoc {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (!isObj(parsed)) {
    throw new Error(`${file} is not a JSON object`)
  }
  return parsed as OpenapiDoc
}

/** Runs the command line; returns the process exit code. */
export function main(argv: string[], hubRoot: string): number {
  const checkAt = argv.indexOf('--check')
  const target = join(hubRoot, 'public-openapi.json')
  if (checkAt >= 0) {
    const file = argv[checkAt + 1] ?? target
    const text = readFileSync(file, 'utf8')
    const problems = checkPublicOpenapi(readDoc(file))
    if (serialise(JSON.parse(text) as OpenapiDoc) !== text) {
      problems.push('not in the canonical form: run bun run public-openapi')
    }
    for (const problem of problems) {
      console.error(problem)
    }
    return problems.length === 0 ? 0 : 1
  }
  const rootAt = argv.indexOf('--services-root')
  const root = resolve(rootAt >= 0 ? (argv[rootAt + 1] ?? '') : dirname(hubRoot))
  const docs: Record<string, OpenapiDoc> = {}
  for (const name of SERVICES) {
    const file = join(root, `tula-closeline-${name}`, 'openapi.json')
    if (existsSync(file)) {
      docs[name] = readDoc(file)
    }
  }
  const outAt = argv.indexOf('--out')
  const out = outAt >= 0 ? resolve(argv[outAt + 1] ?? '') : target
  const built = buildPublicOpenapi(docs)
  writeFileSync(out, serialise(built))
  console.log(
    `${Object.keys(built.paths ?? {}).length} public paths from ${Object.keys(docs).join(', ')} -> ${out}`
  )
  return 0
}

if (import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2), join(import.meta.dir, '..')))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
