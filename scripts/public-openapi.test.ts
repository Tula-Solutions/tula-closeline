import './test-guard.ts'
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildPublicOpenapi,
  checkPublicOpenapi,
  type Json,
  type OpenapiDoc,
  serialise,
  validateOpenapi,
} from './public-openapi.ts'

const HUB_ROOT = join(import.meta.dir, '..')

function service(paths: Record<string, Json>, components: Record<string, Json> = {}): OpenapiDoc {
  return {
    openapi: '3.1.0',
    info: { title: 'svc', version: '0.0.0' },
    components: {
      securitySchemes: { accessToken: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      ...components,
    },
    paths,
    webhooks: {},
  }
}

const ok = { '200': { description: 'ok' } }
const tokenSecurity = [{ accessToken: [] }]

function publicGet(scope = 'prospects:read', extra: Record<string, Json> = {}): Json {
  return {
    summary: 'x',
    security: tokenSecurity,
    responses: ok,
    'x-closeline-public': true,
    'x-closeline-scopes': [scope],
    ...extra,
  }
}

const privateGet: Json = { summary: 'private', security: tokenSecurity, responses: ok }

describe('buildPublicOpenapi', () => {
  test('keeps only operations marked public and drops the rest, including webhooks', () => {
    const core = service({
      '/v1/prospects': { get: publicGet(), post: privateGet },
      '/v1/teams': { get: privateGet },
      '/internal/x': { get: privateGet },
    })
    const result = buildPublicOpenapi({ core })
    expect(Object.keys(result.paths ?? {})).toEqual(['/v1/prospects'])
    const methods = Object.keys((result.paths as Record<string, Json>)['/v1/prospects'] as object)
    expect(methods).toEqual(['get'])
    expect(result.webhooks).toBeUndefined()
  })

  test('core alone with nothing marked is a valid OpenAPI 3.1 document', () => {
    const result = buildPublicOpenapi({ core: service({ '/v1/teams': { get: privateGet } }) })
    expect(result.openapi).toBe('3.1.0')
    expect(result.paths).toEqual({})
    expect(validateOpenapi(result)).toEqual([])
  })

  test('requires core', () => {
    expect(() => buildPublicOpenapi({ auth: service({}) })).toThrow(/core/)
  })

  test('rejects a public route that has no scope', () => {
    const op = publicGet()
    delete (op as Record<string, Json>)['x-closeline-scopes']
    const core = service({ '/v1/prospects': { get: op } })
    expect(() => buildPublicOpenapi({ core })).toThrow(/GET \/v1\/prospects.*scope/)
  })

  test('rejects an empty, unknown-shaped or multiple scope list', () => {
    for (const scopes of [[], ['prospects'], ['prospects:admin'], ['a:read', 'b:read'], 'x']) {
      const core = service({
        '/v1/prospects': { get: publicGet('prospects:read', { 'x-closeline-scopes': scopes }) },
      })
      expect(() => buildPublicOpenapi({ core })).toThrow(/scope/)
    }
  })

  test('a read route needs a read scope and a write route a write scope', () => {
    const wrongGet = service({ '/v1/prospects': { get: publicGet('prospects:write') } })
    expect(() => buildPublicOpenapi({ core: wrongGet })).toThrow(/read/)
    const wrongPost = service({ '/v1/prospects': { post: publicGet('prospects:read') } })
    expect(() => buildPublicOpenapi({ core: wrongPost })).toThrow(/write/)
  })

  test('rejects a marked route that is not under /v1 or is internal', () => {
    for (const path of ['/prospects', '/internal/v1/contact-checks', '/v1/../x']) {
      const core = service({ [path]: { get: publicGet() } })
      expect(() => buildPublicOpenapi({ core })).toThrow(/\/v1/)
    }
  })

  test('rejects a marked route that does not take the access token', () => {
    const core = service({ '/v1/x': { get: publicGet('prospects:read', { security: [] }) } })
    expect(() => buildPublicOpenapi({ core })).toThrow(/accessToken/)
  })

  test('x-closeline-public must be exactly true when present', () => {
    const core = service({
      '/v1/x': { get: publicGet('prospects:read', { 'x-closeline-public': 'yes' }) },
    })
    expect(() => buildPublicOpenapi({ core })).toThrow(/x-closeline-public/)
  })

  test('merges services, rejects the same method and path twice', () => {
    const core = service({ '/v1/prospects': { get: publicGet() } })
    const playbook = service({ '/v1/playbook/documents': { get: publicGet('playbook:read') } })
    const merged = buildPublicOpenapi({ core, playbook })
    expect(Object.keys(merged.paths ?? {})).toEqual(['/v1/playbook/documents', '/v1/prospects'])
    const dup = service({ '/v1/prospects': { get: publicGet() } })
    expect(() => buildPublicOpenapi({ core, playbook: dup })).toThrow(/twice|duplicate/i)
  })

  test('keeps only the components that marked routes reach, following references', () => {
    const op = publicGet('prospects:read', {
      responses: {
        '200': {
          description: 'ok',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Page' } } },
        },
      },
    })
    const core = service(
      { '/v1/prospects': { get: op }, '/v1/teams': { get: privateGet } },
      {
        schemas: {
          Page: { type: 'object', properties: { item: { $ref: '#/components/schemas/Item' } } },
          Item: { type: 'string' },
          Secret: { type: 'string' },
        },
      }
    )
    const result = buildPublicOpenapi({ core })
    expect(Object.keys((result.components as Record<string, Json>).schemas as object)).toEqual([
      'Item',
      'Page',
    ])
    expect(validateOpenapi(result)).toEqual([])
  })

  test('refuses two services that define one component name differently', () => {
    const op = (name: string) =>
      publicGet('prospects:read', {
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } },
          },
        },
      })
    const core = service(
      { '/v1/a': { get: op('Page') } },
      { schemas: { Page: { type: 'string' } } }
    )
    const playbook = service(
      { '/v1/b': { get: op('Page') } },
      { schemas: { Page: { type: 'number' } } }
    )
    expect(() => buildPublicOpenapi({ core, playbook })).toThrow(/Page/)
    const same = service(
      { '/v1/b': { get: op('Page') } },
      { schemas: { Page: { type: 'string' } } }
    )
    expect(() => buildPublicOpenapi({ core, playbook: same })).not.toThrow()
  })

  test('a dangling reference is refused', () => {
    const op = publicGet('prospects:read', {
      responses: { '200': { $ref: '#/components/responses/Missing' } },
    })
    expect(() => buildPublicOpenapi({ core: service({ '/v1/a': { get: op } }) })).toThrow(/Missing/)
  })

  test('the output is the same whatever order services and keys arrive in', () => {
    const core = service({
      '/v1/b': { get: publicGet() },
      '/v1/a': { get: publicGet(), post: publicGet('prospects:write') },
    })
    const playbook = service({ '/v1/p': { get: publicGet('playbook:read') } })
    const one = serialise(buildPublicOpenapi({ core, playbook }))
    const reordered = JSON.parse(JSON.stringify(core)) as OpenapiDoc
    reordered.paths = Object.fromEntries(Object.entries(core.paths ?? {}).reverse())
    const two = serialise(buildPublicOpenapi({ playbook, core: reordered }))
    expect(two).toBe(one)
    expect(one.endsWith('\n')).toBe(true)
    expect(one.indexOf('"/v1/a"')).toBeLessThan(one.indexOf('"/v1/b"'))
  })

  test('does not change its input', () => {
    const core = service({ '/v1/a': { get: publicGet() } })
    const before = JSON.stringify(core)
    buildPublicOpenapi({ core })
    expect(JSON.stringify(core)).toBe(before)
  })
})

describe('review findings', () => {
  test('a public route may name only the access token scheme', () => {
    const core = service({
      '/v1/x': {
        get: publicGet('prospects:read', {
          security: [{ accessToken: [] }, { internalSecret: [] }],
        }),
      },
    })
    expect(() => buildPublicOpenapi({ core })).toThrow(/internalSecret/)
  })

  test('the duplicate route error names both services', () => {
    const core = service({ '/v1/prospects': { get: publicGet() } })
    const playbook = service({ '/v1/prospects': { get: publicGet() } })
    expect(() => buildPublicOpenapi({ core, playbook })).toThrow(/core.*playbook/)
  })

  test('the check fails on a webhook in the document', () => {
    const doc = buildPublicOpenapi({ core: service({}) })
    doc.webhooks = { hook: { post: { responses: ok } } }
    expect(checkPublicOpenapi(doc).join('\n')).toMatch(/webhook/)
  })
})

describe('checkPublicOpenapi', () => {
  test('passes a built document', () => {
    const doc = buildPublicOpenapi({ core: service({ '/v1/a': { get: publicGet() } }) })
    expect(checkPublicOpenapi(doc)).toEqual([])
  })

  test('fails on an operation that is not marked public', () => {
    const doc = buildPublicOpenapi({ core: service({ '/v1/a': { get: publicGet() } }) })
    const paths = doc.paths as Record<string, Record<string, Record<string, Json>>>
    const op = paths['/v1/a']?.get
    if (op === undefined) {
      throw new Error('missing operation')
    }
    delete op['x-closeline-public']
    const problems = checkPublicOpenapi(doc)
    expect(problems.join('\n')).toMatch(/GET \/v1\/a.*not marked/)
  })

  test('fails on a hand-added route and on a missing scope', () => {
    const doc = buildPublicOpenapi({ core: service({}) })
    doc.paths = { '/v1/x': { post: { responses: ok, security: tokenSecurity } } }
    expect(checkPublicOpenapi(doc).length).toBeGreaterThan(0)
    doc.paths = {
      '/v1/x': { post: { responses: ok, security: tokenSecurity, 'x-closeline-public': true } },
    }
    expect(checkPublicOpenapi(doc).join('\n')).toMatch(/scope/)
  })

  test('fails on a path outside /v1', () => {
    const doc = buildPublicOpenapi({ core: service({}) })
    doc.paths = { '/internal/x': { get: publicGet() } }
    expect(checkPublicOpenapi(doc).join('\n')).toMatch(/\/v1/)
  })
})

describe('the committed public-openapi.json', () => {
  test('exists, is valid, is marked throughout and is in the canonical form', () => {
    const file = join(HUB_ROOT, 'public-openapi.json')
    expect(existsSync(file)).toBe(true)
    const text = readFileSync(file, 'utf8')
    const doc = JSON.parse(text) as OpenapiDoc
    expect(checkPublicOpenapi(doc)).toEqual([])
    expect(serialise(doc)).toBe(text)
  })
})
