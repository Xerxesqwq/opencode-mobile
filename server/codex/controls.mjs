const fail = (status, message) => Object.assign(new Error(message), { status })

export function settingsFromResume(result) {
  return {
    model: result.model ?? result.thread.model ?? null,
    effort: result.reasoningEffort ?? result.thread.reasoningEffort ?? null,
    approvalPolicy: result.approvalPolicy ?? null,
    approvalsReviewer: result.approvalsReviewer ?? null,
    sandboxPolicy: result.sandbox ?? null,
    activePermissionProfile: result.activePermissionProfile ?? null,
    collaborationMode: result.collaborationMode ?? null,
    serviceTier: result.serviceTier ?? null,
    instructionSources: result.instructionSources ?? [],
  }
}

export function controlSnapshot(state) {
  const settings = state.settings || {}
  return {
    model: settings.model ?? state.thread.model ?? null,
    effort: settings.effort ?? state.thread.reasoningEffort ?? null,
    approvalPolicy: settings.approvalPolicy ?? null,
    approvalsReviewer: settings.approvalsReviewer ?? null,
    sandboxPolicy: settings.sandboxPolicy ?? null,
    permissionProfile: settings.activePermissionProfile?.id ?? null,
    mode: settings.collaborationMode?.mode ?? 'default',
    serviceTier: settings.serviceTier ?? null,
    instructionSources: settings.instructionSources ?? [],
    tokenUsage: state.tokenUsage ?? null,
    compacting: !!state.compacting,
    runtimeStatus: state.thread.status.type,
    plan: state.plan ?? null,
    canAcceptDirectInput: state.thread.canAcceptDirectInput !== false,
  }
}

export async function modelCatalog(rpc) {
  const rows = [], seen = new Set()
  for (let cursor; ;) {
    const page = await rpc.call('model/list', { cursor })
    rows.push(...page.data)
    if (!page.nextCursor || seen.has(page.nextCursor)) return rows.filter(model => !model.hidden)
    seen.add(page.nextCursor); cursor = page.nextCursor
  }
}

export async function controlOptions(rpc, cwd) {
  const [models, profiles, requirements, modes] = await Promise.all([
    modelCatalog(rpc),
    rpc.call('permissionProfile/list', { cwd }),
    rpc.call('configRequirements/read', {}),
    rpc.call('collaborationMode/list', {}),
  ])
  const allowed = requirements.requirements?.allowedApprovalPolicies
  return {
    models: models.map(m => ({ id: m.model, name: m.displayName,
      efforts: m.supportedReasoningEfforts, defaultEffort: m.defaultReasoningEffort,
      serviceTiers: m.serviceTiers ?? [] })),
    permissionProfiles: profiles.data,
    approvalPolicies: ['untrusted', 'on-request', 'never'].filter(policy => !allowed || allowed.includes(policy)),
    modes: modes.data.filter(mode => ['default', 'plan'].includes(mode.mode)).map(mode => mode.mode),
  }
}

export async function settingsPatch(rpc, state, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, 'A settings object is required')
  const keys = Object.keys(body)
  if (!keys.length || keys.some(key => !['model', 'effort', 'approvalPolicy', 'permissions', 'mode', 'serviceTier'].includes(key))) {
    throw fail(400, 'Choose model, reasoning effort, permissions, approval policy, mode or service tier')
  }
  if (state.thread.canAcceptDirectInput === false) throw fail(409, 'This thread does not accept direct input')
  const options = await controlOptions(rpc, state.thread.cwd)
  const modelId = body.model ?? state.settings?.model ?? state.thread.model
  const model = options.models.find(model => model.id === modelId)
  const params = { threadId: state.thread.id }
  if ('model' in body && !model) throw fail(400, 'Choose an available Codex model')
  if ('model' in body) params.model = model.id
  if ('serviceTier' in body) {
    if (body.serviceTier !== null && (!['priority', 'fast'].includes(body.serviceTier) ||
      !model?.serviceTiers.some(tier => tier.id === body.serviceTier))) {
      throw fail(400, 'Fast mode is not supported by this model')
    }
    params.serviceTier = body.serviceTier
  } else if ('model' in body && state.settings?.serviceTier && state.settings.serviceTier !== 'default' &&
    !model.serviceTiers.some(tier => tier.id === state.settings.serviceTier)) {
    params.serviceTier = null
  }
  if ('effort' in body) {
    const effort = body.effort === 'default' ? model?.defaultEffort : body.effort
    if (!model?.efforts.some(option => option.reasoningEffort === effort)) throw fail(400, 'Reasoning effort is not supported by this model')
    params.effort = effort
  } else if ('model' in body && !model.efforts.some(option => option.reasoningEffort === state.settings?.effort)) {
    params.effort = model.defaultEffort
  }
  if ('permissions' in body) {
    if (!options.permissionProfiles.some(profile => profile.id === body.permissions && profile.allowed)) {
      throw fail(400, 'This permission profile is unavailable or restricted by server policy')
    }
    params.permissions = body.permissions
  }
  if ('approvalPolicy' in body) {
    if (!options.approvalPolicies.includes(body.approvalPolicy)) throw fail(400, 'This approval policy is restricted by server policy')
    params.approvalPolicy = body.approvalPolicy
  }
  if ('mode' in body) {
    if (!options.modes.includes(body.mode) || !model) throw fail(400, 'Choose an available collaboration mode and model')
    params.collaborationMode = { mode: body.mode, settings: {
      model: model.id, reasoning_effort: params.effort ?? state.settings?.effort ?? model.defaultEffort,
      developer_instructions: null,
    } }
  }
  return params
}
