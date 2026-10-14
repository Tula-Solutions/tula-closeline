import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { COMPOSE_PROJECT, DEFAULT_PORTS, PLAYBOOK_QUEUE, ROLES, STORAGE_BUCKET } from './dev-lib.ts'

const file = join(import.meta.dir, '..', 'compose.dev.yaml')
const text = readFileSync(file, 'utf8')

type Service = {
  image: string
  environment?: Record<string, string>
  ports?: string[]
  volumes?: string[]
  tmpfs?: string[]
  healthcheck?: { test: string[] }
}
const compose = Bun.YAML.parse(text) as { name: string; services: Record<string, Service> }
const services = Object.entries(compose.services)

/** The role a `*_PASSWORD` variable of the Postgres image or the db library's init.sh sets. */
function roleOf(variable: string): string {
  const name = variable.replace(/_PASSWORD$/, '').toLowerCase()
  return name
}

describe('compose.dev.yaml', () => {
  test('is the closeline-dev project, so --down cannot reach another project', () => {
    expect(compose.name).toBe(COMPOSE_PROJECT)
  })

  test('every *_PASSWORD under postgres is the password of a role the script rotates', () => {
    const variables = Object.keys(compose.services.postgres?.environment ?? {}).filter((name) =>
      name.endsWith('_PASSWORD')
    )
    expect(variables.length).toBeGreaterThanOrEqual(5)
    const rotated: readonly string[] = ROLES
    const missing = variables.map(roleOf).filter((role) => !rotated.includes(role))
    expect(missing).toEqual([])
  })

  test('every rotated role has a bootstrap password, so none is missing from the file', () => {
    const roles = Object.keys(compose.services.postgres?.environment ?? {})
      .filter((name) => name.endsWith('_PASSWORD'))
      .map(roleOf)
    expect(roles.sort()).toEqual([...ROLES].sort())
  })

  test('binds every published port to 127.0.0.1', () => {
    const published = services.flatMap(([, service]) => service.ports ?? [])
    expect(published).toHaveLength(4)
    for (const port of published) {
      expect(port).toStartWith('127.0.0.1:')
    }
  })

  test('uses the documented default ports', () => {
    expect(text).toContain(`:-${DEFAULT_PORTS.postgres}}:5432`)
    expect(text).toContain(`:-${DEFAULT_PORTS.queue}}:9324`)
    expect(text).toContain(`:-${DEFAULT_PORTS.storage}}:9090`)
    expect(text).toContain(`:-${DEFAULT_PORTS.mail}}:8025`)
  })

  test('pins every image by exact tag and digest, never latest', () => {
    expect(services).toHaveLength(4)
    for (const [, service] of services) {
      expect(service.image).toMatch(/^[a-z0-9./_-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/)
      expect(service.image).not.toContain('latest')
      expect(service.image).toMatch(/:v?\d+\.\d+/)
    }
    expect(text).not.toMatch(/:latest\b/)
  })

  test('has a health check on every service, and Postgres asks over TCP, not the init socket', () => {
    for (const [, service] of services) {
      expect(service.healthcheck?.test).toBeDefined()
    }
    const postgres = compose.services.postgres?.healthcheck?.test.join(' ') ?? ''
    expect(postgres).toContain('pg_isready -h 127.0.0.1')
  })

  test('Postgres is version 18, the minimum', () => {
    expect(compose.services.postgres?.image).toStartWith('postgres:18.')
  })

  test('states the minimum Docker Compose version', () => {
    expect(text).toContain('Docker Compose 2.17.0')
  })

  test('the mailbox is Mailpit v1.31.5, publishes only its HTTP port and keeps nothing on disk', () => {
    const mail = compose.services.mail
    expect(mail?.image).toStartWith('axllent/mailpit:v1.31.5@sha256:')
    expect(mail?.ports).toHaveLength(1)
    expect(mail?.ports?.[0]).toMatch(/^127\.0\.0\.1:\$\{CLOSELINE_DEV_MAIL_PORT:-8026\}:8025$/)
    const all = JSON.stringify(mail)
    expect(all).not.toContain('1025')
    expect(mail?.volumes ?? []).toEqual([])
    expect(mail?.environment?.MP_DATABASE).toBeUndefined()
    expect(mail?.healthcheck?.test.join(' ')).toContain('readyz')
  })

  test('the mailbox makes no outbound call: its version check is off', () => {
    expect(String(compose.services.mail?.environment?.MP_DISABLE_VERSION_CHECK)).toBe('1')
  })

  test('the queue stand-in mounts its declared /data, so --down --volumes leaves no anonymous volume', () => {
    const queue = compose.services.queue
    const named = (queue?.volumes ?? []).some((volume) => volume.endsWith(':/data'))
    const memory = (queue?.tmpfs ?? []).includes('/data')
    expect(named || memory).toBe(true)
    // A named volume must be one that `down --volumes` removes: declared at the top level.
    for (const volume of queue?.volumes ?? []) {
      const [source] = volume.split(':')
      if (source && !source.startsWith('.') && !source.startsWith('/')) {
        expect(text).toMatch(new RegExp(`^  ${source}:`, 'm'))
      }
    }
  })
})

describe('the playbook dev stack', () => {
  const queueConf = readFileSync(join(import.meta.dir, 'dev', 'elasticmq.conf'), 'utf8')

  test('the queue stand-in defines the queue the playbook is given as QUEUE_URL', () => {
    expect(queueConf).toMatch(new RegExp(`^\\s*${PLAYBOOK_QUEUE}\\s*\\{`, 'm'))
  })

  test('the bucket the playbook is given exists in the object storage stand-in', () => {
    const buckets =
      compose.services.storage?.environment?.COM_ADOBE_TESTING_S3MOCK_STORE_INITIAL_BUCKETS
    expect(String(buckets).split(',')).toContain(STORAGE_BUCKET)
  })
})
