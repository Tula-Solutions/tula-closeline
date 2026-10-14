// A stand-in for the playbook service, used only by the smoke test's own tests. It behaves like the
// real one for the calls the sales-history steps make (rights, Calls, Deals, Deal imports, one
// Organization per token) and each option breaks one thing, so a test can show the smoke test
// notices. Processing is simulated by counting reads of a Call or an import.

/** What can be broken in the playbook fake. Every option is off by default. */
export type PlaybookFakeOptions = {
  /** Every list and every read by id ignores the Organization in the token. */
  leak?: boolean
  /** The rights confirmation of one Organization counts for every other. */
  sharedRights?: boolean
  /** A Call is accepted before the rights are confirmed. */
  noRightsGate?: boolean
  /** The Transcript never gets past `processing`. */
  transcriptStuck?: boolean
  /** The Transcript fails. */
  transcriptFails?: boolean
  /** The Call of a won Deal never reaches search. */
  notInSearch?: boolean
  /** The Call of an open Deal is in search. */
  openInSearch?: boolean
  /** The Recording fails. */
  recordingFails?: boolean
  /** The Recording is accepted as a Transcript. */
  recordingAsTranscript?: boolean
  /** The import rejects its last row. */
  importRejectsOne?: boolean
  /** The import never finishes. */
  importStuck?: boolean
  /** The import does not set the Outcome of a Deal that already exists. */
  importKeepsOutcome?: boolean
  /** A Call is created without its Deal. */
  noDealForCall?: boolean
  /** DELETE answers `deleted` but the Call stays readable and listed as it was. */
  deleteKeeps?: boolean
  /** A deleted Call is still in the default list. */
  deletedStaysListed?: boolean
  /** Deleting a deleted Call again answers 404. */
  deleteAgainNotFound?: boolean
  /** Another Organization's DELETE of a Call works. */
  crossDelete?: boolean
  /** The Deal lookup finds the Deals of every Organization. */
  crossLookup?: boolean
  /** The Call, Deal and import lists always answer with no items. */
  emptyLists?: boolean
}

type Call = {
  id: string
  orgId: string
  dealRecordId: string
  dealId: string
  kind: 'transcript' | 'recording'
  state: string
  reads: number
  deleted: boolean
}
type Deal = {
  id: string
  orgId: string
  dealId: string
  outcome: string
  calls: number
  appeared: boolean
}
type Import = { id: string; orgId: string; reads: number; rows: string[][] }

const CURRENT_WORDING = 3
const READS_TO_FINISH = 2

/** A request handler for the fake playbook. `orgOf` maps a bearer token to its Organization id. */
export function createPlaybookFake(
  orgOf: (token: string) => string | undefined,
  options: PlaybookFakeOptions = {}
) {
  const rights = new Map<string, true>()
  const calls: Call[] = []
  const deals: Deal[] = []
  const imports: Import[] = []
  let counter = 0
  const next = (prefix: string) => `${prefix}_${(++counter).toString(16).padStart(32, '0')}`

  const json = (body: unknown, status = 200) => Response.json(body, { status })
  const error = (status: number, code: string) => json({ error: { code } }, status)

  const publicCall = (call: Call) => {
    const deal = deals.find((candidate) => candidate.id === call.dealRecordId)
    const ready = call.state === 'ready'
    return {
      id: call.id,
      dealId: call.dealId,
      dealRecordId: call.dealRecordId,
      dealOutcome: deal?.outcome ?? 'open',
      inSearch:
        ready &&
        !call.deleted &&
        !options.notInSearch &&
        (deal?.outcome === 'won' || options.openInSearch === true),
      kind: call.kind,
      state: call.deleted && !options.deleteKeeps ? 'deleted' : call.state,
      failureReason: call.state === 'failed' ? 'transcription_failed' : null,
    }
  }
  const publicDeal = (deal: Deal) => ({
    id: deal.id,
    dealId: deal.dealId,
    outcome: deal.outcome,
    callCount: deal.calls,
    appearedInImport: deal.appeared,
  })

  /** Moves a Call along each time it is read, as the background job would. */
  const advance = (call: Call) => {
    call.reads += 1
    if (call.state === 'failed' || call.state === 'ready' || call.state === 'awaiting_rep') {
      return
    }
    if (call.kind === 'transcript') {
      if (options.transcriptStuck) {
        call.state = 'processing'
      } else if (call.reads >= READS_TO_FINISH) {
        call.state = options.transcriptFails ? 'failed' : 'ready'
      } else {
        call.state = 'processing'
      }
    } else if (call.reads >= READS_TO_FINISH) {
      call.state = options.recordingFails ? 'failed' : 'awaiting_rep'
    } else {
      call.state = 'transcribing'
    }
  }

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const { pathname } = url
    const method = request.method
    if (pathname === '/readyz') {
      return json({ status: 'ok' })
    }
    const token = request.headers.get('authorization')?.replace(/^Bearer /, '')
    const orgId = token ? orgOf(token) : undefined
    if (!orgId) {
      return error(401, token ? 'auth.token_invalid' : 'auth.unauthenticated')
    }
    const mine = <T extends { orgId: string }>(rows: T[]) =>
      options.leak ? rows : rows.filter((row) => row.orgId === orgId)
    const confirmed = () => rights.has(options.sharedRights ? 'shared' : orgId)

    if (pathname === '/v1/playbook/rights-confirmation') {
      if (method === 'PUT') {
        const body = (await request.json()) as { wordingVersion?: number }
        if (body.wordingVersion !== CURRENT_WORDING) {
          return error(409, 'rights.version_outdated')
        }
        rights.set(options.sharedRights ? 'shared' : orgId, true)
      }
      return json({ currentWordingVersion: CURRENT_WORDING, confirmed: confirmed() })
    }

    if (pathname === '/v1/playbook/calls' && method === 'POST') {
      if (!confirmed() && !options.noRightsGate) {
        return error(403, 'rights.confirmation_required')
      }
      const form = await request.formData()
      const file = form.get('file')
      const dealId = String(form.get('dealId') ?? '')
      if (!(file instanceof File) || dealId === '') {
        return error(400, 'request.invalid')
      }
      const recording = /\.(wav|mp3)$/i.test(file.name) && !options.recordingAsTranscript
      let deal = deals.find((d) => d.orgId === orgId && d.dealId === dealId)
      if (!deal) {
        deal = {
          id: next('deal'),
          orgId,
          dealId,
          outcome: 'open',
          calls: 0,
          appeared: false,
        }
        if (!options.noDealForCall) {
          deals.push(deal)
        }
      }
      deal.calls += 1
      const call: Call = {
        id: next('call'),
        orgId,
        dealRecordId: deal.id,
        dealId,
        kind: recording ? 'recording' : 'transcript',
        state: 'uploaded',
        reads: 0,
        deleted: false,
      }
      calls.push(call)
      return json(publicCall(call), 201)
    }
    if (pathname === '/v1/playbook/calls' && method === 'GET') {
      const wanted = url.searchParams.get('state')
      const dealRecordId = url.searchParams.get('dealRecordId')
      const rows = mine(calls).filter(
        (call) => dealRecordId === null || call.dealRecordId === dealRecordId
      )
      const shown = rows.filter((call) =>
        wanted === 'deleted'
          ? call.deleted
          : !call.deleted || options.deletedStaysListed || options.deleteKeeps
      )
      const none = options.emptyLists && dealRecordId === null
      return json({ items: none ? [] : shown.map(publicCall), nextCursor: null })
    }
    const callMatch = /^\/v1\/playbook\/calls\/([^/]+)(\/restore|\/rep)?$/.exec(pathname)
    if (callMatch) {
      const call = calls.find(
        (candidate) =>
          candidate.id === callMatch[1] &&
          (candidate.orgId === orgId ||
            options.leak ||
            (options.crossDelete && method === 'DELETE'))
      )
      if (!call) {
        return error(404, 'call.not_found')
      }
      if (method === 'DELETE') {
        if (call.deleted && options.deleteAgainNotFound) {
          return error(404, 'call.not_found')
        }
        call.deleted = true
        return json({ ...publicCall(call), state: 'deleted', inSearch: false })
      }
      if (callMatch[2] !== undefined) {
        return call.orgId === orgId ? json(publicCall(call)) : error(404, 'call.not_found')
      }
      advance(call)
      return json(publicCall(call))
    }

    if (pathname === '/v1/playbook/deals' && method === 'GET') {
      return json({
        items: options.emptyLists ? [] : mine(deals).map(publicDeal),
        nextCursor: null,
      })
    }
    if (pathname === '/v1/playbook/deals/lookup' && method === 'POST') {
      const body = (await request.json()) as { dealId?: string }
      const found = deals.find(
        (deal) => deal.dealId === body.dealId && (deal.orgId === orgId || options.crossLookup)
      )
      return found ? json(publicDeal(found)) : error(404, 'deal.not_found')
    }
    const dealMatch = /^\/v1\/playbook\/deals\/([^/]+)(\/outcome)?$/.exec(pathname)
    if (dealMatch) {
      const found = deals.find(
        (deal) => deal.id === dealMatch[1] && (deal.orgId === orgId || options.leak)
      )
      return found ? json(publicDeal(found)) : error(404, 'deal.not_found')
    }

    if (pathname === '/v1/playbook/deal-imports' && method === 'POST') {
      if (!confirmed() && !options.noRightsGate) {
        return error(403, 'rights.confirmation_required')
      }
      const form = await request.formData()
      const file = form.get('file')
      if (!(file instanceof File)) {
        return error(400, 'request.invalid')
      }
      const lines = (await file.text()).split('\n').filter((line) => line.trim() !== '')
      const rows = lines.slice(1).map((line) => line.split(','))
      const created: Import = { id: next('dimp'), orgId, reads: 0, rows }
      imports.push(created)
      return json({ id: created.id, state: 'uploaded' }, 202)
    }
    if (pathname === '/v1/playbook/deal-imports' && method === 'GET') {
      return json({
        items: options.emptyLists
          ? []
          : mine(imports).map((item) => ({ id: item.id, state: 'completed' })),
        nextCursor: null,
      })
    }
    const importMatch = /^\/v1\/playbook\/deal-imports\/([^/]+)(\/rows)?$/.exec(pathname)
    if (importMatch) {
      const found = imports.find(
        (item) => item.id === importMatch[1] && (item.orgId === orgId || options.leak)
      )
      if (!found) {
        return error(404, 'deal_import.not_found')
      }
      if (importMatch[2] !== undefined) {
        return json({ items: found.rows.map((row, index) => ({ rowNumber: index + 2, row })) })
      }
      found.reads += 1
      if (options.importStuck || found.reads < READS_TO_FINISH) {
        return json({ id: found.id, state: 'processing' })
      }
      if (found.reads === READS_TO_FINISH) {
        found.rows.forEach((row, index) => {
          const id = row[0] ?? ''
          let deal = deals.find((d) => d.orgId === found.orgId && d.dealId === id)
          if (!deal) {
            deal = {
              id: next('deal'),
              orgId: found.orgId,
              dealId: id,
              outcome: 'open',
              calls: 0,
              appeared: false,
            }
            deals.push(deal)
          }
          deal.appeared = true
          if (!options.importKeepsOutcome || deal.calls === 0) {
            deal.outcome = row[1] ?? 'open'
          }
          if (options.importRejectsOne && index === found.rows.length - 1) {
            deals.splice(deals.indexOf(deal), 1)
          }
        })
      }
      const rejected = options.importRejectsOne ? 1 : 0
      return json({
        id: found.id,
        state: 'completed',
        rowCount: found.rows.length,
        appliedCount: found.rows.length - rejected,
        rejectedCount: rejected,
      })
    }
    return new Response('{}', { status: 404 })
  }
}
