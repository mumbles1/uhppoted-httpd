import { DB, alive } from './db.js'
import { schema } from './schema.js'

const config = window.gateControl || {}
const app = document.getElementById('app')
const notice = document.getElementById('notice')
const connectionDot = document.getElementById('connection-dot')
const connectionLabel = document.getElementById('connection-label')
const controllerDialog = document.getElementById('controller-dialog')
const controllerForm = document.getElementById('controller-form')
const doorDialog = document.getElementById('door-dialog')
const doorForm = document.getElementById('door-form')
const cardDialog = document.getElementById('card-dialog')
const cardForm = document.getElementById('card-form')
const credentialBulkDialog = document.getElementById('credential-bulk-dialog')
const credentialBulkForm = document.getElementById('credential-bulk-form')
const managementGroupDialog = document.getElementById('management-group-dialog')
const personDialog = document.getElementById('person-dialog')
const personForm = document.getElementById('person-form')
const groupDialog = document.getElementById('group-dialog')
const groupForm = document.getElementById('group-form')
const backupDialog = document.getElementById('backup-dialog')
const controllerImportDialog = document.getElementById('controller-import-dialog')
const routes = ['overview', 'controllers', 'doors', 'cards', 'groups', 'events', 'logs']
const accessWeekdays = [
  ['monday', 'Mon'], ['tuesday', 'Tue'], ['wednesday', 'Wed'], ['thursday', 'Thu'],
  ['friday', 'Fri'], ['saturday', 'Sat'], ['sunday', 'Sun'],
]
const permanentAccessLevels = new Set(['0.5.254', '0.5.255'])

let loading = false
let emptyCardRetries = 0
let emptyCardRetryTimer = null
let groupSearch = ''
let credentialSearch = ''
let eventSearch = ''
let eventTypeFilter = 'all'
let relayStatus = {}

function currentRoute() {
  const name = window.location.pathname.split('/').pop()?.replace('.html', '') || 'overview'
  return routes.includes(name) ? name : 'overview'
}

function records(source) {
  return [...source.values()].filter((record) => alive(record))
}

function escapeHTML(value) {
  return `${value ?? ''}`
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function display(value, fallback = '—') {
  const text = `${value ?? ''}`.trim()
  return escapeHTML(text || fallback)
}

function statusBadge(status) {
  const value = `${status || 'unknown'}`.toLowerCase()
  const warning = value.includes('error') || value.includes('offline') || value.includes('unknown')
  return `<span class="badge ${warning ? 'warn' : ''}">${escapeHTML(value)}</span>`
}

function setConnection(online, message) {
  connectionDot.className = `status-dot ${online ? 'online' : 'offline'}`
  connectionLabel.textContent = message
}

function showNotice(message, error = false) {
  notice.textContent = message || ''
  notice.className = message ? `notice${error ? ' error' : ''}` : 'notice hidden'

  const dialog = document.querySelector('dialog[open]')
  if (dialog && message) {
    const container = dialog.querySelector('form') || dialog
    let dialogNotice = dialog.querySelector('.dialog-notice')
    if (!dialogNotice) {
      dialogNotice = document.createElement('div')
      dialogNotice.className = 'dialog-notice'
      container.prepend(dialogNotice)
    }
    dialogNotice.textContent = message
    dialogNotice.className = `dialog-notice${error ? ' error' : ''}`
    dialogNotice.setAttribute('role', error ? 'alert' : 'status')
  }
}

document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('close', () => dialog.querySelector('.dialog-notice')?.remove()))

function updateNavigation() {
  const route = currentRoute()
  document.querySelectorAll('[data-route]').forEach((link) => link.classList.toggle('active', link.dataset.route === route))
  document.getElementById('page-title').textContent = route === 'overview' ? 'Overview' : route === 'logs' ? 'Audit log' : route === 'doors' ? 'Relays' : route === 'cards' ? 'Credentials' : route === 'groups' ? 'Access Levels' : route[0].toUpperCase() + route.slice(1)

  const counts = {
    overview: records(DB.controllers).length + controllerDoors().length,
    controllers: records(DB.controllers).length,
    doors: controllerDoors().length,
    cards: records(DB.cards).length,
    groups: records(DB.groups).length,
    events: records(DB.events()).length,
    logs: records(DB.logs()).length,
  }
  Object.entries(counts).forEach(([key, value]) => {
    const element = document.getElementById(`count-${key}`)
    if (element) element.textContent = value
  })
}

function empty(message) {
  return `<div class="empty">${escapeHTML(message)}</div>`
}

function mobileTableRows(headers, rows) {
  return rows.map((row) => {
    let column = 0
    return row.replace(/<td([^>]*)>/g, (_match, attributes) => {
      const label = headers[column] || ''
      column += 1
      return `<td${attributes} data-label="${escapeHTML(label)}">`
    })
  })
}

function panel(title, subtitle, headers, rows) {
  if (!rows.length) return `<section class="panel"><div class="panel-heading"><div><h2>${escapeHTML(title)}</h2><p>${escapeHTML(subtitle)}</p></div></div>${empty(`No ${title.toLowerCase()} are available.`)}</section>`
  const labelledRows = mobileTableRows(headers, rows)
  return `<section class="panel">
    <div class="panel-heading"><div><h2>${escapeHTML(title)}</h2><p>${escapeHTML(subtitle)}</p></div></div>
    <div class="table-wrap"><table><thead><tr>${headers.map((header) => `<th>${escapeHTML(header)}</th>`).join('')}</tr></thead><tbody>${labelledRows.join('')}</tbody></table></div>
  </section>`
}

function controllerRows(list = records(DB.controllers)) {
  return list.map((controller) => `<tr>
    <td class="name-cell"><strong>${display(controller.name, `Controller ${controller.deviceID || ''}`)}</strong><small>${display(controller.address?.address)}</small></td>
    <td>${display(controller.deviceID)}</td>
    <td>${display(controller.protocol)}</td>
    <td>${display(controller.cards?.cards, '0')}</td>
    <td>${display(controller.events?.last, '0')}</td>
    <td>${statusBadge(controller.address?.status || controller.status)}</td>
    <td><button class="secondary" data-edit-controller="${escapeHTML(controller.OID)}" ${config.mode === 'monitor' ? 'disabled' : ''}>Configure</button></td>
  </tr>`)
}

function controllerCapacity(controller) {
  const modelDoors = Number(`${controller?.deviceID || ''}`.trim()[0])
  return [1, 2, 4].includes(modelDoors) ? modelDoors : 4
}

function controllerForDoor(doorOID) {
  return records(DB.controllers).find((controller) => Object.values(controller.doors || {}).includes(doorOID))
}

function controllerDoors() {
  const rows = []
  const assigned = new Set()

  records(DB.controllers).forEach((controller) => {
    const capacity = controllerCapacity(controller)
    for (let channel = 1; channel <= capacity; channel += 1) {
      const doorOID = controller.doors?.[channel] || ''
      const door = doorOID ? DB.doors.get(doorOID) : null
      if (doorOID) assigned.add(doorOID)
      rows.push({ controller, channel, door })
    }
  })

  records(DB.doors).forEach((door) => {
    if (!assigned.has(door.OID)) rows.push({ controller: controllerForDoor(door.OID), channel: null, door })
  })

  return rows
}

function doorRows(list = controllerDoors()) {
  return list.map(({ controller, channel, door }) => {
    const disabled = config.mode === 'monitor' ? 'disabled' : ''
    const controllerName = controller?.name || (controller?.deviceID ? `Controller ${controller.deviceID}` : 'Unassigned')
    const doorName = door?.name || (channel ? `Door ${channel}` : 'Unnamed door')
    const target = door ? `data-door="${escapeHTML(door.OID)}"` : `data-controller="${escapeHTML(controller?.deviceID)}" data-channel="${channel}"`
    const live = relayStatus?.[controller?.deviceID]?.[channel]
    const readers = [door?.readerEntry, door?.readerExit].filter(Boolean).join(' / ')
    return `<tr>
      <td class="name-cell"><strong>${display(doorName)}</strong><small>${display(controllerName)}${controller?.deviceID ? ` · ${escapeHTML(controller.deviceID)}` : ''}${readers ? ` · ${escapeHTML(readers)}` : ''}</small></td>
      <td>${display(({ 'normally open': 'Open', 'normally closed': 'Close', controlled: 'Controlled' })[door?.mode?.mode] || door?.mode?.mode, door ? 'Unknown' : 'Not configured')}</td>
      <td>${door ? `${display(door.delay?.delay, '0')}s` : '—'}</td>
      <td>${door ? (door.keypad ? 'Enabled' : 'Disabled') : '—'}</td>
      <td>${relayStateBadge(live, controller)}</td>
      <td><div class="door-actions">
        <button class="primary" ${target} data-mode="normally open" ${disabled}>Open</button>
        <button class="secondary" ${target} data-mode="controlled" ${disabled}>Controlled</button>
        <button class="danger" ${target} data-mode="normally closed" ${disabled}>Close</button>
      </div></td>
    </tr>`
  })
}

function relayStateBadge(live, controller) {
	if (!controller) return '<span class="badge warn">Unassigned</span>'
	if (!live) return '<span class="badge warn">Unavailable</span>'
	const state = live['relay-active'] ? 'Relay active' : live['door-open'] ? 'Door open' : 'Secure'
	const suffix = live.stale ? ' · last known' : ''
	return `<span class="badge ${state === 'Secure' && !live.stale ? '' : 'warn'}">${state}${suffix}</span>`
}

function _cardRows(list = records(DB.cards)) {
  return list.map((card) => {
    const memberships = [...(card.groups?.values?.() || [])].filter((group) => group.member).length
    const credential = formatCredential(card.number)
    return `<tr>
      <td class="name-cell"><strong>${display(card.name, 'Unnamed credential')}</strong><small>${display(credentialTypeLabel(card.kind))} · ${display(card.OID)}</small></td>
      <td>${credential ? `<span class="name-cell"><strong>FC ${credential.facilityCode} · CD ${credential.cardNumber}</strong><small>Controller ID ${escapeHTML(credential.raw)}</small></span>` : display(card.number)}</td><td>${display(card.from)}</td><td>${display(card.to)}</td><td>${memberships}</td><td>${statusBadge(card.status)}</td>
      <td><button class="secondary" data-edit-card="${escapeHTML(card.OID)}" ${config.mode === 'monitor' ? 'disabled' : ''}>Edit credential</button></td>
    </tr>`
  })
}

function credentialSearchText(card) {
  const credential = formatCredential(card.number)
  return [card.managementGroup, card.name, card.label, card.kind, credentialTypeLabel(card.kind), card.number, credential?.facilityCode, credential?.cardNumber, card.OID]
    .map((value) => `${value ?? ''}`.toLowerCase()).join(' ')
}

function managementGroups() {
  const groups = new Map()
  records(DB.cards).forEach((card) => {
    const name = `${card.managementGroup || ''}`.trim()
    if (!name) return
    const key = name.toLocaleLowerCase()
    if (!groups.has(key)) groups.set(key, { name, cards: [] })
    groups.get(key).cards.push(card)
  })
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }))
}

function normalizedPersonName(name) {
  return `${name || ''}`.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

function canonicalPeople() {
  const people = new Map()
  records(DB.cards)
    .sort((a, b) => `${a.OID}`.localeCompare(`${b.OID}`, undefined, { numeric: true }))
    .forEach((card) => {
      const key = normalizedPersonName(card.name)
      if (!key || people.has(key)) return
      people.set(key, {
        name: `${card.name || ''}`.trim().replace(/\s+/g, ' '),
        managementGroup: `${card.managementGroup || ''}`.trim(),
      })
    })
  return people
}

function refreshManagementGroupOptions() {
  document.getElementById('management-group-options').innerHTML = managementGroups()
    .map((group) => `<option value="${escapeHTML(group.name)}"></option>`).join('')
}

function populateManagementGroupSelect(form, selected = '') {
  const groups = managementGroups()
  const select = form.elements.managementGroup
  const match = groups.find((group) => group.name.toLocaleLowerCase() === `${selected || ''}`.trim().toLocaleLowerCase())
  select.innerHTML = `<option value="">Ungrouped</option>${groups.map((group) => `<option value="${escapeHTML(group.name)}">${escapeHTML(group.name)}</option>`).join('')}<option value="__new__">Create new group&hellip;</option>`
  select.value = match?.name || ''
  form.elements.managementGroupNew.value = ''
  updateManagementGroupNewField(form)
}

function updateManagementGroupNewField(form) {
  const field = form.elements.managementGroupNew.closest('label')
  const creating = form.elements.managementGroup.value === '__new__'
  field.classList.toggle('hidden', !creating)
  form.elements.managementGroupNew.required = creating
  if (creating) form.elements.managementGroupNew.focus()
}

function selectedManagementGroup(form) {
  if (form.elements.managementGroup.value !== '__new__') return form.elements.managementGroup.value.trim()
  const name = form.elements.managementGroupNew.value.trim()
  if (!name) throw new Error('Enter a name for the new management group.')
  const existing = managementGroups().find((group) => group.name.toLocaleLowerCase() === name.toLocaleLowerCase())
  return existing?.name || name
}

function setManagementGroupValue(form, value) {
  const name = `${value || ''}`.trim()
  const option = [...form.elements.managementGroup.options].find((item) => item.value.toLocaleLowerCase() === name.toLocaleLowerCase())
  if (option || !name) {
    form.elements.managementGroup.value = option?.value || ''
    form.elements.managementGroupNew.value = ''
  } else {
    form.elements.managementGroup.value = '__new__'
    form.elements.managementGroupNew.value = name
  }
  updateManagementGroupNewField(form)
}

function existingPerson(name, excludeOID = '') {
  const normalized = normalizedPersonName(name)
  if (!normalized) return null
  return records(DB.cards)
    .filter((card) => card.OID !== excludeOID && normalizedPersonName(card.name) === normalized)
    .sort((a, b) => `${a.OID}`.localeCompare(`${b.OID}`, undefined, { numeric: true }))[0] || null
}

function useExistingPersonGroup() {
  const match = existingPerson(cardForm.elements.name.value, cardForm.dataset.oid)
  if (!match) return
  cardForm.elements.name.value = `${match.name || ''}`.trim()
  setManagementGroupValue(cardForm, match.managementGroup)
}

function renderManagementGroups() {
  const groups = managementGroups()
  document.getElementById('management-group-list').innerHTML = groups.length
    ? groups.map((group) => `<div class="management-group-row" data-management-group="${escapeHTML(group.name)}">
      <label class="management-group-field"><span>${group.cards.length} credential${group.cards.length === 1 ? '' : 's'}</span><input type="text" value="${escapeHTML(group.name)}" list="management-group-options" aria-label="New name for ${escapeHTML(group.name)}"></label>
      <button type="button" class="secondary" data-rename-management-group>Rename / merge</button>
      <button type="button" class="danger" data-remove-management-group>Remove group</button>
    </div>`).join('')
    : empty('No management groups exist yet. Create one while adding or editing a credential.')
  document.querySelectorAll('[data-rename-management-group]').forEach((button) => button.addEventListener('click', renameManagementGroup))
  document.querySelectorAll('[data-remove-management-group]').forEach((button) => button.addEventListener('click', removeManagementGroup))
}

function openManagementGroups() {
  refreshManagementGroupOptions()
  renderManagementGroups()
  managementGroupDialog.showModal()
}

async function updateManagementGroup(source, target) {
  const matches = records(DB.cards).filter((card) => `${card.managementGroup || ''}`.trim().toLocaleLowerCase() === source.trim().toLocaleLowerCase())
  const updates = matches.map((card) => ({ oid: `${card.OID}${schema.cards.managementGroup}`, value: target.trim() }))
  if (!updates.length) throw new Error('That management group no longer has any credentials.')
  await postConfiguration('/cards', { created: [], updated: updates, deleted: [] })
  await load()
  refreshManagementGroupOptions()
  renderManagementGroups()
  return matches.length
}

async function renameManagementGroup(event) {
  const row = event.currentTarget.closest('[data-management-group]')
  const source = row?.dataset.managementGroup || ''
  const target = row?.querySelector('input')?.value.trim() || ''
  if (!target) return showNotice('Enter a management group name, or use Remove group.', true)
  if (source.toLocaleLowerCase() === target.toLocaleLowerCase() && source === target) return showNotice('The management group name is unchanged.')
  event.currentTarget.disabled = true
  try {
    const count = await updateManagementGroup(source, target)
    showNotice(`${count} credential${count === 1 ? '' : 's'} moved to ${target}. Matching groups and full names were consolidated.`)
  } catch (error) {
    showNotice(error.message || 'Unable to rename the management group.', true)
  } finally {
    event.currentTarget.disabled = false
  }
}

async function removeManagementGroup(event) {
  const row = event.currentTarget.closest('[data-management-group]')
  const source = row?.dataset.managementGroup || ''
  if (!source || !window.confirm(`Remove the ${source} management group? Its credentials will be kept under Ungrouped.`)) return
  event.currentTarget.disabled = true
  try {
    const count = await updateManagementGroup(source, '')
    showNotice(`${source} removed. ${count} credential${count === 1 ? '' : 's'} moved to Ungrouped.`)
  } catch (error) {
    showNotice(error.message || 'Unable to remove the management group.', true)
  } finally {
    event.currentTarget.disabled = false
  }
}

function credentialTree() {
  const query = credentialSearch.trim().toLowerCase()
  const canonical = canonicalPeople()
  const cards = records(DB.cards)
    .filter((card) => !query || credentialSearchText(card).includes(query))
    .sort((a, b) => `${a.managementGroup || ''}\u0000${a.name || ''}\u0000${a.label || ''}\u0000${a.number || ''}`.localeCompare(`${b.managementGroup || ''}\u0000${b.name || ''}\u0000${b.label || ''}\u0000${b.number || ''}`, undefined, { sensitivity: 'base', numeric: true }))
  const managementGroups = new Map()

  cards.forEach((card) => {
    const person = canonical.get(normalizedPersonName(card.name))
    const groupName = `${person?.managementGroup || card.managementGroup || ''}`.trim() || 'Ungrouped'
    const groupKey = groupName.toLocaleLowerCase()
    if (!managementGroups.has(groupKey)) managementGroups.set(groupKey, { name: groupName, people: new Map() })
    const group = managementGroups.get(groupKey)
    const personName = person?.name || `${card.name || ''}`.trim().replace(/\s+/g, ' ') || 'Unassigned person'
    const personKey = normalizedPersonName(personName)
    if (!group.people.has(personKey)) group.people.set(personKey, { name: personName, cards: [] })
    group.people.get(personKey).cards.push(card)
  })

  const branches = [...managementGroups.values()].map((group) => {
    const groupCards = [...group.people.values()].flatMap((person) => person.cards)
    const people = [...group.people.values()].map((person) => {
      const oids = person.cards.map((card) => card.OID).join(',')
      const leaves = person.cards.map((card) => {
        const credential = formatCredential(card.number)
        const memberships = [...(card.groups?.values?.() || [])].filter((membership) => membership.member).length
        const credentialTitle = `${card.label || ''}`.trim() || credentialTypeLabel(card.kind)
        return `<article class="credential-leaf">
          <div class="credential-leaf-main"><strong>${display(credentialTitle)}</strong><span>${credential ? `FC ${credential.facilityCode} &middot; CD ${credential.cardNumber}` : display(card.number)}</span><small>${credential ? `Controller ID ${escapeHTML(credential.raw)} &middot; ` : ''}${memberships} access level${memberships === 1 ? '' : 's'} &middot; ${display(card.from)} to ${display(card.to)}</small></div>
          <button class="secondary" data-edit-card="${escapeHTML(card.OID)}" ${config.mode === 'monitor' ? 'disabled' : ''}>Edit credential</button>
        </article>`
      }).join('')
      return `<details class="credential-tree-person" open>
        <summary><span class="tree-summary-main"><strong>${display(person.name)}</strong><small>${person.cards.length} credential${person.cards.length === 1 ? '' : 's'}</small></span><span class="tree-actions"><button class="secondary" data-edit-person="${escapeHTML(oids)}" ${config.mode === 'monitor' ? 'disabled' : ''}>Edit person</button><button class="secondary tree-manage" data-manage-credentials="${escapeHTML(oids)}" data-manage-label="${escapeHTML(person.name)}" ${config.mode === 'monitor' ? 'disabled' : ''}>Manage access</button></span></summary>
        <div class="credential-tree-leaves">${leaves}</div>
      </details>`
    }).join('')
    const groupOIDs = groupCards.map((card) => card.OID).join(',')
    return `<details class="credential-tree-group" open>
      <summary><span class="tree-summary-main"><strong>${display(group.name)}</strong><small>${group.people.size} ${group.people.size === 1 ? 'person' : 'people'} &middot; ${groupCards.length} credential${groupCards.length === 1 ? '' : 's'}</small></span><button class="secondary tree-manage" data-manage-credentials="${escapeHTML(groupOIDs)}" data-manage-label="${escapeHTML(group.name)}" ${config.mode === 'monitor' ? 'disabled' : ''}>Manage access</button></summary>
      <div class="credential-tree-people">${people}</div>
    </details>`
  }).join('')

  return `<section class="panel credential-tree-panel"><div class="panel-heading"><div><h2>Credentials</h2><p>Management group &rarr; person &rarr; credentials</p></div></div><div class="credential-tree">${branches || empty(query ? 'No credentials match your search.' : 'No credentials are available.')}</div></section>`
}

function filterCredentials(event) {
  credentialSearch = event.currentTarget.value
  const template = document.createElement('template')
  template.innerHTML = credentialTree()
  const next = template.content.querySelector('.credential-tree')
  const current = app.querySelector('.credential-tree')
  if (!next || !current) return
  current.replaceWith(next)
  next.querySelectorAll('[data-edit-card]').forEach((button) => button.addEventListener('click', editCard))
  next.querySelectorAll('[data-edit-person]').forEach((button) => button.addEventListener('click', openPersonEditor))
  next.querySelectorAll('[data-manage-credentials]').forEach((button) => button.addEventListener('click', openBulkCredentialAccess))
}

function openPersonEditor(event) {
  event.preventDefault()
  event.stopPropagation()
  const oids = `${event.currentTarget.dataset.editPerson || ''}`.split(',').filter(Boolean)
  const cards = oids.map((oid) => DB.cards.get(oid)).filter(Boolean)
  if (!cards.length) return
  refreshManagementGroupOptions()
  personForm.dataset.oids = JSON.stringify(oids)
  personForm.elements.name.value = `${cards[0].name || ''}`.trim()
  populateManagementGroupSelect(personForm, cards[0].managementGroup)
  document.getElementById('person-editor-summary').textContent = `Changes apply to all ${cards.length} credential${cards.length === 1 ? '' : 's'} assigned to this person.`
  personDialog.showModal()
}

async function savePerson(event) {
  event.preventDefault()
  const saveButton = document.getElementById('person-editor-save')
  saveButton.disabled = true
  try {
    const oids = new Set(JSON.parse(personForm.dataset.oids || '[]'))
    const cards = [...oids].map((oid) => DB.cards.get(oid)).filter(Boolean)
    let name = personForm.elements.name.value.trim().replace(/\s+/g, ' ')
    let managementGroup = selectedManagementGroup(personForm)
    if (!cards.length) throw new Error('That person no longer has any credentials.')
    if (!name) throw new Error('Full name is required.')
    const match = records(DB.cards)
      .filter((card) => !oids.has(card.OID) && normalizedPersonName(card.name) === normalizedPersonName(name))
      .sort((a, b) => `${a.OID}`.localeCompare(`${b.OID}`, undefined, { numeric: true }))[0]
    if (match) {
      name = `${match.name || ''}`.trim()
      managementGroup = `${match.managementGroup || ''}`.trim()
    }
    const updates = []
    cards.forEach((card) => {
      if (`${card.name || ''}`.trim() !== name) updates.push({ oid: `${card.OID}${schema.cards.name}`, value: name })
      if (`${card.managementGroup || ''}`.trim() !== managementGroup) updates.push({ oid: `${card.OID}${schema.cards.managementGroup}`, value: managementGroup })
    })
    if (updates.length) await postConfiguration('/cards', { created: [], updated: updates, deleted: [] })
    personDialog.close()
    showNotice(match ? `${name} was merged with the existing person.` : `${name} was updated across ${cards.length} credential${cards.length === 1 ? '' : 's'}.`)
    await load()
  } catch (error) {
    showNotice(error.message || 'Unable to update the person.', true)
  } finally {
    saveButton.disabled = false
  }
}

function groupRows(list = records(DB.groups)) {
	return [...list].sort(accessLevelCompare).map((group) => {
		const permitted = [...(group.doors?.values?.() || [])].filter((door) => door.allowed).length
		const action = isPermanentAccessLevel(group) ? '<span class="badge">Permanent</span>' : `<button class="secondary" data-edit-group="${escapeHTML(group.OID)}" ${config.mode === 'monitor' ? 'disabled' : ''}>Configure</button>`
		return `<tr><td class="name-cell"><strong>${display(group.name, 'Unnamed access level')}</strong><small>${display(group.OID)}</small></td><td>${permitted}</td><td>${displayAccessSchedule(group.schedule)}</td><td>${group.firstcard ? 'Yes' : 'No'}</td><td>${statusBadge(group.status)}</td><td>${action}</td></tr>`
	})
}

function isPermanentAccessLevel(group) { return permanentAccessLevels.has(`${group?.OID || ''}`) }
function accessLevelOrder(group) { return group?.OID === '0.5.254' ? -2 : group?.OID === '0.5.255' ? -1 : 0 }
function accessLevelCompare(a, b) {
  const permanent = accessLevelOrder(a) - accessLevelOrder(b)
  if (permanent) return permanent
  const aID = Number(`${a?.OID || ''}`.split('.').slice(-1)[0])
  const bID = Number(`${b?.OID || ''}`.split('.').slice(-1)[0])
  if (Number.isFinite(aID) && Number.isFinite(bID) && aID !== bID) return aID - bID
  const byName = `${a?.name || ''}`.localeCompare(`${b?.name || ''}`, undefined, { numeric: true, sensitivity: 'base' })
  return byName || `${a?.OID || ''}`.localeCompare(`${b?.OID || ''}`, undefined, { numeric: true })
}

function displayAccessSchedule(schedule) {
  if (!schedule?.enabled) return 'Any time'
  const days = accessWeekdays.filter(([key]) => schedule.weekdays?.[key]).map(([, label]) => label).join(', ')
  return `<span class="name-cell"><strong>${escapeHTML(`${schedule.start}–${schedule.end}`)}</strong><small>${escapeHTML(days)}</small></span>`
}

function filterGroups(event) {
  groupSearch = event.currentTarget.value
  const query = groupSearch.trim().toLowerCase()
  const groups = records(DB.groups).filter((group) => !query || `${group.name} ${group.OID}`.toLowerCase().includes(query))
  const body = app.querySelector('tbody')
  if (!body) return
  body.innerHTML = groups.length ? mobileTableRows(['Access level', 'Relays', 'Time restriction', 'First-card', 'Status', ''], groupRows(groups)).join('') : '<tr><td colspan="6">No access levels match your search.</td></tr>'
  body.querySelectorAll('[data-edit-group]').forEach((button) => button.addEventListener('click', editGroup))
}

function eventRows(list = records(DB.events())) {
  return list.sort((a, b) => `${b.timestamp}`.localeCompare(`${a.timestamp}`)).map((event) => {
    const credential = credentialForEvent(event)
    const selectable = credential ? ` class="selectable-row" data-edit-event-card="${escapeHTML(credential.OID)}" title="Open credential configuration"` : ''
    return `<tr${selectable}>
    <td>${display(event.index)}</td><td>${display(formatEventTime(event.timestamp))}</td><td>${display(event.deviceName, event.deviceID)}</td><td>${eventDoor(event)}</td><td>${eventCard(event)}</td><td>${display(eventCredentialType(event))}</td><td>${event.granted === 'true' ? '<span class="badge">Granted</span>' : '<span class="badge warn">Denied</span>'}</td><td>${display(event.reason, event.eventType)}</td>
  </tr>`
  })
}

function bindEventCredentialRows(root = document) {
  root.querySelectorAll('[data-edit-event-card]').forEach((row) => row.addEventListener('click', (event) => {
    editCard({ currentTarget: { dataset: { editCard: event.currentTarget.dataset.editEventCard } } })
  }))
}

function credentialTypeLabel(kind) {
  return ({ card: 'Card', 'rf-remote': 'RF Remote', 'keypad-code': 'Keypad Code', unknown: 'Unknown' })[kind] || 'Card'
}

function credentialForEvent(event) {
  return records(DB.cards).find((card) => `${card.number}` === `${event.card}`)
}

function eventCredentialType(event) {
  const credential = credentialForEvent(event)
  return credential ? credentialTypeLabel(credential.kind) : 'Unknown'
}

function filteredEvents() {
  const query = eventSearch.trim().toLowerCase()
  return records(DB.events()).filter((event) => {
    const credentialRecord = credentialForEvent(event)
    const kind = credentialRecord?.kind || 'unknown'
    if (eventTypeFilter !== 'all' && kind !== eventTypeFilter) return false
    if (!query) return true
    const credentialNumber = credentialRecord?.number || event.card
    const decoded = formatCredential(credentialNumber)
    return [
      event.index, event.timestamp, formatEventTime(event.timestamp),
      event.deviceID, `controller ${event.deviceID}`, `controller id ${event.deviceID}`, event.deviceName,
      event.door, event.doorName, event.direction,
      credentialNumber, `credential ${credentialNumber}`, event.cardName, credentialRecord?.name,
      decoded?.facilityCode, decoded?.cardNumber,
      decoded ? `fc ${decoded.facilityCode} cd ${decoded.cardNumber}` : '',
      decoded ? `${decoded.facilityCode}-${decoded.cardNumber}` : '',
      credentialTypeLabel(kind), event.reason, event.eventType,
    ]
      .some((value) => `${value ?? ''}`.toLowerCase().includes(query))
  })
}

function refreshEventRows() {
  const body = app.querySelector('tbody')
  if (!body) return
  const events = filteredEvents()
  body.innerHTML = events.length ? mobileTableRows(['Event #', 'Time', 'Controller', 'Door', 'Credential', 'Type', 'Access', 'Reason'], eventRows(events)).join('') : '<tr><td colspan="8">No events match your search and filter.</td></tr>'
  bindEventCredentialRows(body)
}

function eventDoor(event) {
  const controller = records(DB.controllers).find((item) => `${item.deviceID}` === `${event.deviceID}`)
  const door = controller?.doors?.[event.door] ? DB.doors.get(controller.doors[event.door]) : null
  const reader = `${event.direction}` === 'out' ? door?.readerExit : `${event.direction}` === 'in' ? door?.readerEntry : ''
  return `<span class="name-cell"><strong>${display(event.doorName, event.door)}</strong>${reader ? `<small>${escapeHTML(reader)}</small>` : ''}</span>`
}

function formatEventTime(value) {
  const text = `${value || ''}`.trim()
  const local = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/)
  const date = local
    ? new Date(Number(local[1]), Number(local[2]) - 1, Number(local[3]), Number(local[4]), Number(local[5]), Number(local[6]))
    : new Date(text)
  return Number.isNaN(date.getTime()) ? text : new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'medium' }).format(date)
}

function eventCard(event) {
  const number = `${event.card || ''}`.trim()
  const name = `${event.cardName || ''}`.trim()
  const credential = formatCredential(number)
  if (name && credential) return `<span class="name-cell"><strong>${escapeHTML(name)}</strong><small>FC ${credential.facilityCode} · CD ${credential.cardNumber} · Controller ID ${escapeHTML(credential.raw)}</small></span>`
  if (credential) return `<span class="name-cell"><strong>FC ${credential.facilityCode} · CD ${credential.cardNumber}</strong><small>Controller ID ${escapeHTML(credential.raw)}</small></span>`
  if (name && number && number !== '0') return `<span class="name-cell"><strong>${escapeHTML(name)}</strong><small>Controller ID ${escapeHTML(number)}</small></span>`
  if (number && number !== '0') return `<span class="name-cell"><strong>Credential ${escapeHTML(number)}</strong></span>`
  return display(number && number !== '0' ? number : '', '—')
}

function formatCredential(value) {
  const wiegand = decodeFacilityCard(value)
  if (!wiegand || `${value}`.trim() === '0') return null
  return { raw: `${value}`.trim(), ...wiegand }
}

function decodeFacilityCard(value) {
  const raw = `${value ?? ''}`.trim()
  if (!raw) return null
  const number = Number(raw)
  if (!Number.isSafeInteger(number) || number < 0 || number > 25599999) return null
  return { facilityCode: Math.floor(number / 100000), cardNumber: number % 100000 }
}

function populateFacilityCard(value) {
  const wiegand = decodeFacilityCard(value)
  cardForm.elements.facilityCode.value = wiegand?.facilityCode ?? ''
  cardForm.elements.cardNumber.value = wiegand?.cardNumber ?? ''
}

function populateDecimalCard() {
  const facilityCode = cardForm.elements.facilityCode.value
  const cardNumber = cardForm.elements.cardNumber.value
  if (facilityCode === '' || cardNumber === '') return
  const fc = Number(facilityCode)
  const cn = Number(cardNumber)
  if (Number.isInteger(fc) && fc >= 0 && fc <= 255 && Number.isInteger(cn) && cn >= 0 && cn <= 99999) {
    cardForm.elements.number.value = `${fc * 100000 + cn}`
  }
}

function logRows(list = records(DB.logs())) {
  return list.sort((a, b) => `${b.timestamp}`.localeCompare(`${a.timestamp}`)).map((entry) => `<tr><td>${display(entry.timestamp)}</td><td>${display(entry.uid)}</td><td>${display(entry.item?.type)}</td><td>${display(entry.item?.details)}</td></tr>`)
}

function overview() {
  const controllers = records(DB.controllers)
  const doors = controllerDoors()
  const cards = records(DB.cards)
  const groups = records(DB.groups)
  const fullNames = new Set(cards.map((card) => normalizedPersonName(card.name)).filter(Boolean)).size
  const managementGroupCount = new Set(cards.map((card) => `${card.managementGroup || ''}`.trim().toLowerCase()).filter(Boolean)).size
  return `<div class="stats">
    <a class="stat" href="/sys/controllers.html"><span>Controllers</span><strong>${controllers.length}</strong></a>
    <a class="stat" href="/sys/doors.html"><span>Relays</span><strong>${doors.length}</strong></a>
    <a class="stat credential-stat" href="/sys/cards.html"><span>Active credentials</span><strong>${cards.length}</strong><small><b>${fullNames}</b> full names <i>&middot;</i> <b>${managementGroupCount}</b> management groups</small></a>
    <a class="stat" href="/sys/groups.html"><span>Access levels</span><strong>${groups.length}</strong></a>
  </div>
  <div class="two-column">
    ${panel('Controllers', 'Connected access-control hardware', ['Controller', 'ID', 'Protocol', 'Credentials', 'Events', 'Status', ''], controllerRows(controllers))}
    ${panel('Recent events', 'Latest controller activity', ['Event #', 'Time', 'Controller', 'Door', 'Credential', 'Type', 'Access', 'Reason'], eventRows().slice(0, 8))}
  </div>`
}

function render() {
  updateNavigation()
  switch (currentRoute()) {
    case 'controllers': app.innerHTML = panel('Controllers', 'Controller health and configuration', ['Controller', 'ID', 'Protocol', 'Credentials', 'Events', 'Status', ''], controllerRows()); break
    case 'doors': app.innerHTML = panel('Relays', config.mode === 'monitor' ? 'Monitor mode — controls are disabled' : 'Live relay state and controls', ['Relay / door', 'Mode', 'Delay', 'Keypad', 'Status', 'Controls'], doorRows()); break
    case 'cards': app.innerHTML = credentialTree(); break
    case 'groups': app.innerHTML = panel('Access Levels', 'Controller-native relay access assignments', ['Access level', 'Relays', 'Time restriction', 'First-card', 'Status', ''], groupRows()); break
    case 'events': app.innerHTML = panel('Events', 'Recent controller events', ['Event #', 'Time', 'Controller', 'Door', 'Credential', 'Type', 'Access', 'Reason'], eventRows()); break
    case 'logs': app.innerHTML = panel('Audit log', 'Recent configuration changes', ['Time', 'User', 'Item', 'Details'], logRows()); break
    default: app.innerHTML = overview()
  }

  if (currentRoute() === 'cards') {
    app.querySelector('.panel-heading')?.insertAdjacentHTML('beforeend', `<div class="panel-tools"><input class="panel-search" data-credential-search type="search" placeholder="Search people, groups, or credentials" aria-label="Search credentials" value="${escapeHTML(credentialSearch)}"><button class="secondary" data-manage-groups ${config.mode === 'monitor' ? 'disabled' : ''}>Manage groups</button><a class="secondary button-link" href="/api/v1/credentials.csv" download>Download CSV</a><button class="secondary" data-export-credentials>Save CSV</button><button class="primary" data-add-card ${config.mode === 'monitor' ? 'disabled' : ''}>Add credential</button></div>`)
  }
  if (currentRoute() === 'controllers') {
    app.querySelector('.panel-heading')?.insertAdjacentHTML('beforeend', `<div class="panel-tools"><button class="secondary" data-open-backups>Backups</button><button class="primary" data-import-controller>Import from controller</button></div>`)
  }
  if (currentRoute() === 'groups') {
    app.querySelector('.panel-heading')?.insertAdjacentHTML('beforeend', `<div class="panel-tools"><input class="panel-search" data-group-search type="search" placeholder="Search access levels" aria-label="Search access levels" value="${escapeHTML(groupSearch)}"><button class="primary" data-add-group ${config.mode === 'monitor' ? 'disabled' : ''}>Add access level</button></div>`)
  }
  if (currentRoute() === 'events') {
    app.querySelector('.panel-heading')?.insertAdjacentHTML('beforeend', `<div class="panel-tools"><input class="panel-search" data-event-search type="search" placeholder="Credential or controller ID" aria-label="Search events by credential number or controller ID" value="${escapeHTML(eventSearch)}"><select class="panel-search" data-event-type-filter aria-label="Filter credential type"><option value="all">All credential types</option><option value="rf-remote">RF Remote</option><option value="card">Card</option><option value="keypad-code">Keypad Code</option><option value="unknown">Unknown</option></select></div>`)
    const filter = document.querySelector('[data-event-type-filter]')
    if (filter) filter.value = eventTypeFilter
  }

  document.querySelectorAll('[data-mode][data-door], [data-mode][data-controller][data-channel]').forEach((button) => button.addEventListener('click', controlDoor))
  document.querySelectorAll('[data-edit-controller]').forEach((button) => button.addEventListener('click', editController))
  document.querySelectorAll('[data-add-door], [data-edit-door]').forEach((button) => button.addEventListener('click', editDoor))
  document.querySelectorAll('[data-add-card], [data-edit-card]').forEach((button) => button.addEventListener('click', editCard))
  document.querySelectorAll('[data-edit-person]').forEach((button) => button.addEventListener('click', openPersonEditor))
  document.querySelectorAll('[data-manage-credentials]').forEach((button) => button.addEventListener('click', openBulkCredentialAccess))
  document.querySelectorAll('[data-add-group], [data-edit-group]').forEach((button) => button.addEventListener('click', editGroup))
  bindEventCredentialRows(app)
  document.querySelector('[data-group-search]')?.addEventListener('input', filterGroups)
  document.querySelector('[data-credential-search]')?.addEventListener('input', filterCredentials)
  document.querySelector('[data-event-search]')?.addEventListener('input', (event) => { eventSearch = event.currentTarget.value; refreshEventRows() })
  document.querySelector('[data-event-type-filter]')?.addEventListener('change', (event) => { eventTypeFilter = event.currentTarget.value; refreshEventRows() })
  document.querySelector('[data-export-credentials]')?.addEventListener('click', exportCredentials)
  document.querySelector('[data-manage-groups]')?.addEventListener('click', openManagementGroups)
  document.querySelector('[data-open-backups]')?.addEventListener('click', openBackups)
  document.querySelector('[data-import-controller]')?.addEventListener('click', previewControllerImport)
  if (currentRoute() === 'groups' && groupSearch) filterGroups({ currentTarget: { value: groupSearch } })
}

function formatBytes(value) {
  const bytes = Number(value) || 0
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

async function loadBackups() {
  const list = document.getElementById('backup-list')
  list.innerHTML = '<span class="spinner"></span> Loading backups&hellip;'
  const response = await fetch('/api/v1/backups', { credentials: 'same-origin', cache: 'no-store' })
  if (!response.ok) throw new Error((await response.text()) || `Unable to load backups (${response.status})`)
  const backups = await response.json()
  list.innerHTML = backups.length ? backups.map((backup) => `<div class="backup-row"><span><strong>${display(backup.name)}</strong><small>${display(new Date(backup.createdAt).toLocaleString())} &middot; ${display(formatBytes(backup.size))}</small></span><span class="backup-actions"><a class="secondary button-link" href="/api/v1/backups/download?name=${encodeURIComponent(backup.name)}" download>Download</a><button type="button" class="danger" data-restore-backup="${escapeHTML(backup.name)}">Restore</button></span></div>`).join('') : empty('No backups have been created yet.')
  list.querySelectorAll('[data-restore-backup]').forEach((button) => button.addEventListener('click', restoreBackup))
}

async function openBackups() {
  backupDialog.showModal()
  try {
    await loadBackups()
  } catch (error) {
    showNotice(error.message || 'Unable to load backups.', true)
  }
}

async function createBackup() {
  const button = document.getElementById('backup-create')
  button.disabled = true
  try {
    const result = await postConfiguration('/api/v1/backups', { reason: 'manual backup' })
    showNotice(`Backup created: ${result.backup.name}`)
    await loadBackups()
  } catch (error) {
    showNotice(error.message || 'Backup failed.', true)
  } finally {
    button.disabled = false
  }
}

async function importBackup(event) {
  const file = event.currentTarget.files?.[0]
  if (!file) return
  const form = new FormData()
  form.append('backup', file)
  try {
    const response = await fetch('/api/v1/backups/import', { method: 'POST', credentials: 'same-origin', body: form })
    if (!response.ok) throw new Error((await response.text()) || `Backup import failed (${response.status})`)
    const result = await response.json()
    showNotice(`Backup validated and stored as ${result.backup.name}. Review it below before restoring.`)
    await loadBackups()
  } catch (error) {
    showNotice(error.message || 'Backup import failed.', true)
  } finally {
    event.currentTarget.value = ''
  }
}

async function restoreBackup(event) {
  const name = event.currentTarget.dataset.restoreBackup
  if (!window.confirm(`Restore ${name}? A safety backup will be created first and Access Control - HTTP will restart automatically.`)) return
  event.currentTarget.disabled = true
  try {
    await postConfiguration('/api/v1/backups/restore', { name })
    showNotice('Backup restored. Access Control - HTTP is restarting&hellip;')
    backupDialog.close()
    setTimeout(() => window.location.reload(), 3500)
  } catch (error) {
    showNotice(error.message || 'Restore failed.', true)
    event.currentTarget.disabled = false
  }
}

async function previewControllerImport() {
  const preview = document.getElementById('controller-import-preview')
  const apply = document.getElementById('controller-import-apply')
  preview.innerHTML = '<span class="spinner"></span> Reading controller credentials&hellip;'
  apply.disabled = true
  controllerImportDialog.showModal()
  try {
    const response = await fetch('/api/v1/controllers/import', { credentials: 'same-origin', cache: 'no-store' })
    if (!response.ok) throw new Error((await response.text()) || `Controller read failed (${response.status})`)
    const result = await response.json()
    const eligible = Number(result.supported || 0) + Number(result.resolvable || 0)
    preview.innerHTML = `<div class="import-summary"><strong>${eligible} available to import</strong><span>${result.resolvable || 0} need a choice &middot; ${result.skipped} blocked for safety &middot; ${result.controllers} controller(s)</span></div>${(result.warnings || []).map((warning) => `<p class="import-warning">${display(warning)}</p>`).join('')}<div class="import-records">${(result.credentials || []).map(renderControllerImportRecord).join('') || empty('No credentials were returned by the controller.')}</div>`
    apply.disabled = eligible < 1
  } catch (error) {
    preview.innerHTML = `<div class="dialog-notice error">${display(error.message || 'Controller read failed.')}</div>`
  }
}

function renderControllerImportRecord(credential) {
  const eligible = credential.supported || credential.resolvable
  const cardNumber = escapeHTML(credential.cardNumber)
  const localChoice = credential.localMatch ? `<label class="import-choice">Existing local match<select data-import-mode><option value="merge">Merge: keep local dates and PIN</option><option value="override">Override: use controller dates and PIN</option></select></label>` : ''
  const controllerChoice = credential.resolvable ? `<label class="import-choice">Controller values<select data-import-controller required><option value="">Select controller</option>${credential.controllers.map((id) => `<option value="${escapeHTML(id)}">Controller ${display(id)}</option>`).join('')}</select></label>` : ''
  const controls = eligible ? `<div class="import-record-controls"><label class="import-toggle"><input type="checkbox" data-import-enabled checked> Import this credential</label>${localChoice}${controllerChoice}</div>` : ''
  const status = credential.supported ? '<span class="badge">Ready</span>' : credential.resolvable ? `<span class="badge warn">Choice required</span><small>${display(credential.warning)}</small>` : `<span class="badge warn">Blocked</span><small>${display(credential.warning)}</small>`
  return `<div class="import-record ${eligible ? '' : 'unsupported'}" data-import-card="${cardNumber}" data-import-resolvable="${credential.resolvable ? 'true' : 'false'}"><span><strong>Credential ${display(credential.cardNumber)}${credential.localMatch ? ' · Local match' : ''}</strong><small>${display(credential.from)} to ${display(credential.to)} &middot; ${credential.relays.length} relay(s)</small></span><span class="import-record-status">${status}</span>${controls}</div>`
}

function controllerImportResolutions() {
  const resolutions = {}
  document.querySelectorAll('[data-import-card]').forEach((record) => {
    const enabled = record.querySelector('[data-import-enabled]')
    if (!enabled) return
    const mode = enabled.checked ? (record.querySelector('[data-import-mode]')?.value || 'override') : 'skip'
    const controller = Number(record.querySelector('[data-import-controller]')?.value || 0)
    if (enabled.checked && record.dataset.importResolvable === 'true' && !controller) {
      throw new Error(`Select a source controller for credential ${record.dataset.importCard}.`)
    }
    resolutions[record.dataset.importCard] = { mode, controller }
  })
  return resolutions
}

async function applyControllerImport() {
  let resolutions
  try {
    resolutions = controllerImportResolutions()
  } catch (error) {
    showNotice(error.message, true)
    return
  }
  if (!window.confirm('Apply the selected merge and override choices to the local database? This will not write to or delete anything from the controller.')) return
  const button = document.getElementById('controller-import-apply')
  button.disabled = true
  try {
    const result = await postConfiguration('/api/v1/controllers/import', { confirmed: true, resolutions })
    controllerImportDialog.close()
    await load()
    showNotice(`Controller import complete: ${result.added} added, ${result.updated} updated, ${result.skipped} skipped. Safety backup: ${result.safetyBackup.name}.`)
  } catch (error) {
    showNotice(error.message || 'Controller import failed.', true)
    button.disabled = false
  }
}

async function exportCredentials() {
  try {
    const response = await fetch('/api/v1/credentials/export', { method: 'POST', credentials: 'same-origin' })
    if (!response.ok) throw new Error((await response.text()) || `CSV export failed (${response.status})`)
    const result = await response.json()
    showNotice(`Credentials CSV saved to ${result.path}.`)
  } catch (error) {
    showNotice(error.message || 'Credentials CSV export failed.', true)
  }
}

function doorAssignment(doorOID) {
  for (const controller of records(DB.controllers)) {
    for (const [channel, assigned] of Object.entries(controller.doors || {})) {
      if (assigned === doorOID) return { controller, channel: Number(channel) }
    }
  }
  return { controller: null, channel: null }
}

function refreshDoorChannels(selected = '') {
  const controller = DB.controllers.get(doorForm.elements.controller.value)
  const editingDoor = doorForm.dataset.oid
  const channels = controller ? Array.from({ length: controllerCapacity(controller) }, (_, index) => index + 1) : []
  doorForm.elements.channel.innerHTML = controller
    ? channels.map((channel) => {
      const assigned = controller.doors?.[channel] || ''
      const occupied = assigned && assigned !== editingDoor
      return `<option value="${channel}" ${`${channel}` === `${selected}` ? 'selected' : ''} ${occupied ? 'disabled' : ''}>Door ${channel}${occupied ? ' (assigned)' : ''}</option>`
    }).join('')
    : '<option value="">Select a controller</option>'
}

function editDoor(event) {
  const door = event.currentTarget.dataset.editDoor ? DB.doors.get(event.currentTarget.dataset.editDoor) : null
  const assigned = door ? doorAssignment(door.OID) : {
    controller: DB.controllers.get(event.currentTarget.dataset.controllerOid),
    channel: Number(event.currentTarget.dataset.channel) || null,
  }

  doorForm.dataset.oid = door?.OID || ''
  doorForm.dataset.originalController = door ? (assigned.controller?.OID || '') : ''
  doorForm.dataset.originalChannel = door ? (assigned.channel || '') : ''
  doorForm.elements.name.value = door?.name || ''
  doorForm.elements.mode.value = door?.mode?.configured || door?.mode?.mode || 'controlled'
  doorForm.elements.delay.value = door?.delay?.configured || door?.delay?.delay || '5'
  doorForm.elements.keypad.checked = Boolean(door?.keypad)
  doorForm.elements.readerEntry.value = door?.readerEntry || ''
  doorForm.elements.readerExit.value = door?.readerExit || ''
  doorForm.elements.controller.innerHTML = ['<option value="">Unassigned</option>', ...records(DB.controllers).map((controller) => `<option value="${escapeHTML(controller.OID)}">${display(controller.name, `Controller ${controller.deviceID}`)}</option>`)].join('')
  doorForm.elements.controller.value = assigned.controller?.OID || ''
  refreshDoorChannels(assigned.channel)
  document.getElementById('door-editor-title').textContent = door ? (door.name || 'Configure door') : 'Add door'
  document.getElementById('door-editor-delete').classList.toggle('hidden', !door)
  doorDialog.showModal()
}

async function postConfiguration(url, body) {
  const response = await fetch(url, {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error((await response.text()) || `Configuration update failed (${response.status})`)
  return response.json()
}

async function synchronizeHardware(path, label) {
  const response = await fetch(path, {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })
  if (!response.ok) {
    const details = (await response.text()).trim() || `request failed (${response.status})`
    throw new Error(`${label} saved locally, but controller synchronization failed: ${details}`)
  }
}

async function saveDoor(event) {
  event.preventDefault()
  const saveButton = document.getElementById('door-editor-save')
  saveButton.disabled = true
  let oid = doorForm.dataset.oid
  const existing = oid ? DB.doors.get(oid) : null

  try {
    if (!oid) {
      const created = await postConfiguration('/doors', { created: [{ oid: '<new>', value: '' }], updated: [], deleted: [] })
      oid = created.doors?.find((item) => item.value === 'new')?.OID
      if (!oid) throw new Error('The server did not return the new door ID.')
    }

    const updates = []
    const changed = (suffix, value, original) => {
      if (!existing || `${value ?? ''}` !== `${original ?? ''}`) updates.push({ oid: `${oid}${suffix}`, value: `${value ?? ''}` })
    }
    changed(schema.doors.name, doorForm.elements.name.value.trim(), existing?.name)
    changed(schema.doors.delay, doorForm.elements.delay.value, existing?.delay?.configured || existing?.delay?.delay)
    changed(schema.doors.mode, doorForm.elements.mode.value, existing?.mode?.configured || existing?.mode?.mode)
    changed(schema.doors.keypad, `${doorForm.elements.keypad.checked}`, `${Boolean(existing?.keypad)}`)
    changed(schema.doors.readerEntry, doorForm.elements.readerEntry.value.trim(), existing?.readerEntry)
    changed(schema.doors.readerExit, doorForm.elements.readerExit.value.trim(), existing?.readerExit)
    if (updates.length) await postConfiguration('/doors', { created: [], updated: updates, deleted: [] })

    const originalController = DB.controllers.get(doorForm.dataset.originalController)
    const originalChannel = Number(doorForm.dataset.originalChannel) || null
    const controller = DB.controllers.get(doorForm.elements.controller.value)
    const channel = Number(doorForm.elements.channel.value) || null
    const assignmentUpdates = []

    if (originalController && (originalController.OID !== controller?.OID || originalChannel !== channel)) {
      assignmentUpdates.push({ oid: `${originalController.OID}${schema.controllers[`door${originalChannel}`]}`, value: '' })
    }
    if (controller && channel && (originalController?.OID !== controller.OID || originalChannel !== channel)) {
      const occupied = controller.doors?.[channel]
      if (occupied && occupied !== oid) throw new Error(`Physical door ${channel} is already assigned.`)
      assignmentUpdates.push({ oid: `${controller.OID}${schema.controllers[`door${channel}`]}`, value: oid })
    }
    if (assignmentUpdates.length) await postConfiguration('/controllers', { created: [], updated: assignmentUpdates, deleted: [] })
    await synchronizeHardware('/synchronize/doors', 'Relay')

    doorDialog.close()
    showNotice(existing ? 'Door configuration saved and synchronized.' : 'Door added, assigned, and synchronized.')
    await load()
    const returnController = DB.controllers.get(doorDialog.dataset.returnController)
    if (returnController && controllerDialog.open) renderControllerDoors(returnController)
    delete doorDialog.dataset.returnController
  } catch (error) {
    showNotice(error.message || 'Door configuration failed.', true)
  } finally {
    saveButton.disabled = false
  }
}

async function deleteDoor() {
  const oid = doorForm.dataset.oid
  const door = oid ? DB.doors.get(oid) : null
  if (!door) return

  const name = door.name || `Door ${oid}`
  if (!window.confirm(`Delete ${name}? This removes its controller assignment and cannot be undone.`)) return

  const deleteButton = document.getElementById('door-editor-delete')
  const saveButton = document.getElementById('door-editor-save')
  deleteButton.disabled = true
  saveButton.disabled = true

  try {
    const assignmentUpdates = []
    for (const controller of records(DB.controllers)) {
      for (const [channel, assigned] of Object.entries(controller.doors || {})) {
        if (assigned === oid) assignmentUpdates.push({ oid: `${controller.OID}${schema.controllers[`door${channel}`]}`, value: '' })
      }
    }

    if (assignmentUpdates.length) {
      await postConfiguration('/controllers', { created: [], updated: assignmentUpdates, deleted: [] })
    }
    await postConfiguration('/doors', { created: [], updated: [], deleted: [oid] })
    await synchronizeHardware('/synchronize/ACL', 'Access rules')

    doorDialog.close()
    showNotice(`${name} deleted and access rules synchronized.`)
    await load()
    const returnController = DB.controllers.get(doorDialog.dataset.returnController)
    if (returnController && controllerDialog.open) renderControllerDoors(returnController)
    delete doorDialog.dataset.returnController
  } catch (error) {
    showNotice(error.message || 'Door deletion failed.', true)
  } finally {
    deleteButton.disabled = false
    saveButton.disabled = false
  }
}

function cardGroupOID(cardOID, groupOID) {
  const match = groupOID.match(schema.groups.regex)
  return match ? `${cardOID}${schema.cards.group}${match[2]}` : ''
}

function cardInGroup(card, group) {
  if (!card) return false
  const oid = cardGroupOID(card.OID, group.OID)
  return Boolean(card.groups?.get?.(oid)?.member || [...(card.groups?.values?.() || [])].some((membership) => membership.member && membership.group === group.OID))
}

function selectedCardGroups() {
  return new Set([...document.querySelectorAll('[data-card-group]:checked')].map((field) => field.dataset.cardGroup))
}

function renderCardGroups(card, selected = null) {
  const groups = records(DB.groups).sort(accessLevelCompare)
  document.getElementById('card-group-fields').innerHTML = groups.length
    ? groups.map((group) => {
      const checked = selected ? selected.has(group.OID) : cardInGroup(card, group)
      return `<label class="choice"><input type="checkbox" data-card-group="${escapeHTML(group.OID)}" ${checked ? 'checked' : ''}><span>${display(group.name, `Access level ${group.OID}`)}</span></label>`
    }).join('')
    : empty('No access levels are available. Add one here, then assign it to this credential.')
}

function openBulkCredentialAccess(event) {
  event.preventDefault()
  event.stopPropagation()
  const oids = `${event.currentTarget.dataset.manageCredentials || ''}`.split(',').filter(Boolean)
  const cards = oids.map((oid) => DB.cards.get(oid)).filter(Boolean)
  if (!cards.length) return
  credentialBulkForm.dataset.oids = JSON.stringify(oids)
  credentialBulkForm.elements.mode.value = 'add'
  const label = event.currentTarget.dataset.manageLabel || 'selected branch'
  document.getElementById('credential-bulk-title').textContent = `Manage ${label}`
  document.getElementById('credential-bulk-summary').textContent = `Apply an access-level change to ${cards.length} credential${cards.length === 1 ? '' : 's'}. Credential names, numbers, and dates are not changed.`
  const groups = records(DB.groups).sort(accessLevelCompare)
  document.getElementById('credential-bulk-levels').innerHTML = groups.length
    ? groups.map((group) => `<label class="choice"><input type="checkbox" data-bulk-group="${escapeHTML(group.OID)}"><span>${display(group.name, `Access level ${group.OID}`)}</span></label>`).join('')
    : empty('No access levels are available.')
  credentialBulkDialog.showModal()
}

async function saveBulkCredentialAccess(event) {
  event.preventDefault()
  const saveButton = document.getElementById('credential-bulk-save')
  saveButton.disabled = true
  try {
    const cards = JSON.parse(credentialBulkForm.dataset.oids || '[]').map((oid) => DB.cards.get(oid)).filter(Boolean)
    const selected = new Set([...document.querySelectorAll('[data-bulk-group]:checked')].map((field) => field.dataset.bulkGroup))
    const mode = credentialBulkForm.elements.mode.value
    if (!cards.length) throw new Error('No credentials are selected.')
    if (mode !== 'replace' && !selected.size) throw new Error('Select at least one access level.')
    if (mode === 'replace' && !selected.size && !window.confirm('Remove every access level from all selected credentials?')) return

    const updates = []
    cards.forEach((card) => records(DB.groups).forEach((group) => {
      const membershipOID = cardGroupOID(card.OID, group.OID)
      const current = cardInGroup(card, group)
      const next = mode === 'replace' ? selected.has(group.OID) : mode === 'remove' ? current && !selected.has(group.OID) : current || selected.has(group.OID)
      if (membershipOID && next !== current) updates.push({ oid: membershipOID, value: `${next}` })
    }))
    if (!updates.length) {
      credentialBulkDialog.close()
      showNotice('The selected credentials already have that access configuration.')
      return
    }
    await postConfiguration('/cards', { created: [], updated: updates, deleted: [] })
    await synchronizeHardware('/synchronize/ACL', 'Credential group')
    credentialBulkDialog.close()
    showNotice(`Access levels updated and synchronized for ${cards.length} credential${cards.length === 1 ? '' : 's'}.`)
    await load()
  } catch (error) {
    showNotice(error.message || 'Group credential update failed.', true)
  } finally {
    saveButton.disabled = false
  }
}

function defaultCardDates() {
  const from = new Date()
  const format = (date) => `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}-${`${date.getDate()}`.padStart(2, '0')}`
  const fromValue = format(from)
  return { from: fromValue, to: addYearsToDate(fromValue, 40) }
}

function addYearsToDate(value, years) {
  const match = `${value || ''}`.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return ''
  const year = Number(match[1]) + years
  const month = Number(match[2])
  const day = Math.min(Number(match[3]), new Date(year, month, 0).getDate())
  return `${year}-${`${month}`.padStart(2, '0')}-${`${day}`.padStart(2, '0')}`
}

function updateValidUntil({ forceDefault = false } = {}) {
  const from = cardForm.elements.from.value
  const until = cardForm.elements.to
  until.min = from
  if (from && (forceDefault || !until.value || until.value < from)) {
    until.value = addYearsToDate(from, 40)
    cardForm.dataset.untilAutomatic = 'true'
  }
}

function updateCredentialPINVisibility() {
  const enabled = records(DB.doors).some((door) => Boolean(door.keypad))
  document.getElementById('card-pin-field').classList.toggle('hidden', !enabled)
}

function editCard(event) {
  const card = event.currentTarget.dataset.editCard ? DB.cards.get(event.currentTarget.dataset.editCard) : null
  const defaults = defaultCardDates()
  cardForm.dataset.oid = card?.OID || ''
  refreshManagementGroupOptions()
  populateManagementGroupSelect(cardForm, card?.managementGroup)
  cardForm.elements.name.value = card?.name || ''
  cardForm.elements.label.value = card?.label || ''
  cardForm.elements.kind.value = card?.kind || 'card'
  cardForm.elements.number.value = card?.number || ''
  populateFacilityCard(card?.number)
  cardForm.elements.PIN.value = card?.PIN || ''
  cardForm.elements.from.value = card?.from || defaults.from
  cardForm.elements.to.value = card?.to || defaults.to
  cardForm.dataset.untilAutomatic = card ? 'false' : 'true'
  updateValidUntil()
  updateCredentialPINVisibility()

  renderCardGroups(card)

  document.getElementById('card-editor-title').textContent = card ? `Edit credential${card.label ? `: ${card.label}` : ''}` : 'Add credential'
  document.getElementById('card-editor-delete').classList.toggle('hidden', !card)
  cardDialog.showModal()
}

function groupAllowsDoor(group, doorOID) {
  return [...(group?.doors?.values?.() || [])].some((permission) => permission.allowed && permission.door === doorOID)
}

function groupDoorOID(groupOID, doorOID) {
  const match = `${doorOID}`.match(schema.doors.regex)
  return match ? `${groupOID}${schema.groups.door}.${match[2]}` : ''
}

function renderGroupDoors(group) {
  const doors = records(DB.doors)
  document.getElementById('group-door-fields').innerHTML = doors.length
    ? doors.map((door) => `<label class="choice"><input type="checkbox" data-group-door="${escapeHTML(door.OID)}" ${groupAllowsDoor(group, door.OID) ? 'checked' : ''}><span>${display(door.name, `Relay ${door.OID}`)}</span></label>`).join('')
    : empty('No configured relays are available yet. You can save the access level and assign relays later.')
}

function renderGroupSchedule(group) {
  const schedule = group?.schedule || { enabled: false, start: '08:00', end: '17:00', weekdays: {} }
  groupForm.elements.scheduleEnabled.checked = Boolean(schedule.enabled)
  groupForm.elements.scheduleStart.value = schedule.start || '08:00'
  groupForm.elements.scheduleEnd.value = schedule.end || '17:00'
  document.getElementById('group-schedule-weekdays').innerHTML = accessWeekdays.map(([key, label]) => {
    const defaultDay = !group && !['saturday', 'sunday'].includes(key)
    const checked = schedule.weekdays?.[key] ?? defaultDay
    return `<label class="choice"><input type="checkbox" data-schedule-day="${key}" ${checked ? 'checked' : ''}><span>${label}</span></label>`
  }).join('')
  document.getElementById('group-schedule-fields').classList.toggle('hidden', !schedule.enabled)
}

function selectedGroupSchedule() {
  const enabled = groupForm.elements.scheduleEnabled.checked
  const weekdays = Object.fromEntries(accessWeekdays.map(([key]) => [key, Boolean(document.querySelector(`[data-schedule-day="${key}"]`)?.checked)]))
  const schedule = {
    enabled,
    start: groupForm.elements.scheduleStart.value || '08:00',
    end: groupForm.elements.scheduleEnd.value || '17:00',
    weekdays,
  }
  if (enabled && !Object.values(weekdays).some(Boolean)) throw new Error('Select at least one access weekday.')
  if (enabled && schedule.end <= schedule.start) throw new Error('Access ends must be after Access starts.')
  return schedule
}

function editGroup(event) {
	const group = event.currentTarget.dataset.editGroup ? DB.groups.get(event.currentTarget.dataset.editGroup) : null
	if (isPermanentAccessLevel(group)) {
		showNotice(`${group.name} is permanent and cannot be configured.`)
		return
	}
  groupForm.dataset.oid = group?.OID || ''
  groupForm.elements.name.value = group?.name || ''
  groupForm.elements.firstcard.checked = Boolean(group?.firstcard)
  groupDialog.dataset.returnCard = event.currentTarget.dataset.fromCard === 'true' ? 'true' : ''
  if (groupDialog.dataset.returnCard) groupDialog.dataset.cardSelections = JSON.stringify([...selectedCardGroups()])
  else delete groupDialog.dataset.cardSelections
  renderGroupDoors(group)
  renderGroupSchedule(group)
  document.getElementById('group-editor-title').textContent = group ? (group.name || 'Configure access level') : 'Add access level'
  document.getElementById('group-editor-delete').classList.toggle('hidden', !group)
  groupDialog.showModal()
}

async function refreshGroupData() {
  const response = await fetch('/api/v1/snapshot', { credentials: 'same-origin', cache: 'no-store' })
  if (!response.ok) throw new Error((await response.text()) || `Unable to refresh access levels (${response.status})`)
  const snapshot = await response.json()
  DB.replace('groups', snapshot.groups || [])
}

async function saveGroup(event) {
  event.preventDefault()
  const saveButton = document.getElementById('group-editor-save')
  saveButton.disabled = true
  let oid = groupForm.dataset.oid
  const existing = oid ? DB.groups.get(oid) : null

  try {
    const name = groupForm.elements.name.value.trim()
    const schedule = selectedGroupSchedule()
    if (records(DB.groups).some((group) => group.OID !== oid && `${group.name}`.trim().toLowerCase() === name.toLowerCase())) {
      throw new Error('An access level with that name already exists.')
    }
    if (!oid) {
      const created = await postConfiguration('/groups', { created: [{ oid: '<new>', value: '' }], updated: [], deleted: [] })
      oid = created.groups?.find((item) => item.value === 'new')?.OID
      if (!oid) throw new Error('The server did not return the new access level ID.')
    }

    const updates = []
    const changed = (suffix, value, original) => {
      if (!existing || `${value ?? ''}` !== `${original ?? ''}`) updates.push({ oid: `${oid}${suffix}`, value: `${value ?? ''}` })
    }
    changed(schema.groups.name, name, existing?.name)
    changed(schema.groups.firstcard, `${groupForm.elements.firstcard.checked}`, `${Boolean(existing?.firstcard)}`)
    changed(schema.groups.schedule, JSON.stringify(schedule), JSON.stringify(existing?.schedule || {}))
    for (const door of records(DB.doors)) {
      const permissionOID = groupDoorOID(oid, door.OID)
      const selected = Boolean(document.querySelector(`[data-group-door="${door.OID}"]`)?.checked)
      if (permissionOID && (!existing || selected !== groupAllowsDoor(existing, door.OID))) updates.push({ oid: permissionOID, value: `${selected}` })
    }
    if (updates.length) {
      await postConfiguration('/groups', { created: [], updated: updates, deleted: [] })
      await synchronizeHardware('/synchronize/ACL', 'Access level')
    }
    await refreshGroupData()

    const returnCard = groupDialog.dataset.returnCard === 'true'
    const selections = new Set(JSON.parse(groupDialog.dataset.cardSelections || '[]'))
    selections.add(oid)
    groupDialog.close()
    if (returnCard && cardDialog.open) {
      const card = cardForm.dataset.oid ? DB.cards.get(cardForm.dataset.oid) : null
      renderCardGroups(card, selections)
      showNotice('Access level created and selected. Save the credential to apply its access.')
    } else {
      showNotice(existing ? 'Access level saved. Save or update credentials to apply membership changes.' : 'Access level added.')
      render()
    }
  } catch (error) {
    showNotice(error.message || 'Access level configuration failed.', true)
  } finally {
    saveButton.disabled = false
  }
}

async function deleteGroup() {
  const oid = groupForm.dataset.oid
  const group = oid ? DB.groups.get(oid) : null
  if (!group) return
  const name = group.name || `Access level ${oid}`
  if (!window.confirm(`Delete ${name}? Credentials assigned only to this access level will lose access.`)) return

  const deleteButton = document.getElementById('group-editor-delete')
  const saveButton = document.getElementById('group-editor-save')
  deleteButton.disabled = true
  saveButton.disabled = true
  try {
    const memberships = records(DB.cards)
      .filter((card) => cardInGroup(card, group))
      .map((card) => ({ oid: cardGroupOID(card.OID, oid), value: 'false' }))
      .filter((item) => item.oid)
    if (memberships.length) await postConfiguration('/cards', { created: [], updated: memberships, deleted: [] })
    await postConfiguration('/groups', { created: [], updated: [], deleted: [oid] })
    await synchronizeHardware('/synchronize/ACL', 'Access rules')
    groupDialog.close()
    showNotice(`${name} deleted and credential access synchronized.`)
    await load()
  } catch (error) {
    showNotice(error.message || 'Access level deletion failed.', true)
  } finally {
    deleteButton.disabled = false
    saveButton.disabled = false
  }
}

async function currentCardOID(card) {
  if (!card?.number) return card?.OID || ''

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch('/api/v1/snapshot', { credentials: 'same-origin', cache: 'no-store' })
    if (!response.ok) throw new Error((await response.text()) || `Unable to refresh credentials (${response.status})`)
    const snapshot = await response.json()
    relayStatus = snapshot.relayStatus || {}
    const number = (snapshot.cards || []).find((item) => {
      const match = `${item.OID || ''}`.match(schema.cards.regex)
      return match && `${item.OID}` === `${match[1]}${schema.cards.card}` && `${item.value}` === `${card.number}`
    })
    const match = `${number?.OID || ''}`.match(schema.cards.regex)
    if (match) return match[1]
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)))
  }

  throw new Error('The credential list is refreshing. Please save again in a moment.')
}

async function saveCard(event) {
  event.preventDefault()
  const saveButton = document.getElementById('card-editor-save')
  saveButton.disabled = true
  let oid = cardForm.dataset.oid
  const existing = oid ? DB.cards.get(oid) : null

  try {
    let managementGroup = selectedManagementGroup(cardForm)
    let name = cardForm.elements.name.value.trim().replace(/\s+/g, ' ')
    const label = cardForm.elements.label.value.trim()
    const number = cardForm.elements.number.value.trim()
    const personMatch = existingPerson(name, existing?.OID)
    if (personMatch) {
      name = `${personMatch.name || ''}`.trim()
      managementGroup = `${personMatch.managementGroup || ''}`.trim()
      cardForm.elements.name.value = name
      setManagementGroupValue(cardForm, managementGroup)
    }
    if (!cardForm.elements.from.value || !cardForm.elements.to.value || cardForm.elements.to.value < cardForm.elements.from.value) {
      throw new Error('Valid until must be on or after Valid from.')
    }
    if (records(DB.cards).some((card) => card.OID !== existing?.OID && `${card.number}`.trim() === number)) {
      throw new Error('A credential with that number already exists.')
    }
    if (existing) oid = await currentCardOID(existing)
    if (!oid) {
      const created = await postConfiguration('/cards', { created: [{ oid: '<new>', value: '' }], updated: [], deleted: [] })
      oid = created.cards?.find((item) => item.value === 'new')?.OID
      if (!oid) throw new Error('The server did not return the new card ID.')
    }

    const updates = []
    const changed = (suffix, value, original) => {
      if (!existing || `${value ?? ''}` !== `${original ?? ''}`) updates.push({ oid: `${oid}${suffix}`, value: `${value ?? ''}` })
    }
    changed(schema.cards.managementGroup, managementGroup, existing?.managementGroup)
    changed(schema.cards.name, name, existing?.name)
    changed(schema.cards.label, label, existing?.label)
    changed(schema.cards.kind, cardForm.elements.kind.value, existing?.kind || 'card')
    changed(schema.cards.card, number, existing?.number)
    if (schema.cards.PIN) changed(schema.cards.PIN, cardForm.elements.PIN.value.trim(), existing?.PIN)
    changed(schema.cards.from, cardForm.elements.from.value, existing?.from)
    changed(schema.cards.to, cardForm.elements.to.value, existing?.to)

    for (const group of records(DB.groups)) {
      const membershipOID = cardGroupOID(oid, group.OID)
      const field = document.querySelector(`[data-card-group="${group.OID}"]`)
      const selected = Boolean(field?.checked)
      if (membershipOID && selected !== cardInGroup(existing, group)) updates.push({ oid: membershipOID, value: `${selected}` })
    }
    if (updates.length) {
      const saved = await postConfiguration('/cards', { created: [], updated: updates, deleted: [] })
      if (!saved.cards?.some((item) => `${item.OID || ''}`.startsWith(`${oid}.`))) {
        throw new Error('The credential changed while it was being saved. Please try again.')
      }
      await synchronizeHardware('/synchronize/ACL', 'Credential')
    }

    cardDialog.close()
    showNotice(existing ? 'Credential configuration saved and synchronized.' : personMatch ? `Credential added under the existing ${name} person and synchronized.` : 'Credential added and synchronized.')
    await load()
  } catch (error) {
    showNotice(error.message || 'Credential configuration failed.', true)
  } finally {
    saveButton.disabled = false
  }
}

async function deleteCard() {
  const oid = cardForm.dataset.oid
  const card = oid ? DB.cards.get(oid) : null
  if (!card) return
  const name = card.name || `Credential ${card.number || oid}`
  if (!window.confirm(`Delete ${name}? This revokes all access-level assignments and cannot be undone.`)) return

  const deleteButton = document.getElementById('card-editor-delete')
  const saveButton = document.getElementById('card-editor-save')
  deleteButton.disabled = true
  saveButton.disabled = true
  try {
    await postConfiguration('/cards', { created: [], updated: [], deleted: [oid] })
    await synchronizeHardware('/synchronize/ACL', 'Credential')
    cardDialog.close()
    showNotice(`${name} deleted and synchronized.`)
    await load()
  } catch (error) {
    showNotice(error.message || 'Credential deletion failed.', true)
  } finally {
    deleteButton.disabled = false
    saveButton.disabled = false
  }
}

function renderControllerDoors(controller) {
  const logicalDoors = records(DB.doors)
  const capacity = controllerCapacity(controller)
  document.getElementById('controller-door-fields').innerHTML = Array.from({ length: capacity }, (_, index) => {
    const channel = index + 1
    const selected = controller.doors?.[channel] || ''
    const options = [`<option value="">Unassigned</option>`, ...logicalDoors.map((door) => `<option value="${escapeHTML(door.OID)}" ${door.OID === selected ? 'selected' : ''}>${display(door.name, `Door ${door.OID}`)}</option>`)]
    return `<div class="controller-door-field">
      <label><span>Physical door ${channel}</span><select name="door${channel}">${options.join('')}</select></label>
      <button type="button" class="secondary" data-configure-controller-door="${channel}">${selected ? 'Configure' : 'Add door'}</button>
    </div>`
  }).join('')

  document.querySelectorAll('[data-configure-controller-door]').forEach((button) => button.addEventListener('click', editControllerDoor))
  document.querySelectorAll('#controller-door-fields select').forEach((select) => select.addEventListener('change', () => {
    select.closest('.controller-door-field').querySelector('button').textContent = select.value ? 'Configure' : 'Add door'
  }))
}

function editControllerDoor(event) {
  const controller = DB.controllers.get(controllerForm.dataset.oid)
  const channel = Number(event.currentTarget.dataset.configureControllerDoor)
  const doorOID = controllerForm.elements[`door${channel}`]?.value || ''
  if (!controller || !channel) return

  if (doorOID) {
    editDoor({ currentTarget: { dataset: { editDoor: doorOID } } })
    doorForm.elements.controller.value = controller.OID
    refreshDoorChannels(channel)
  } else {
    editDoor({ currentTarget: { dataset: { controllerOid: controller.OID, channel: `${channel}` } } })
  }
  doorDialog.dataset.returnController = controller.OID
}

function editController(event) {
  const controller = DB.controllers.get(event.currentTarget.dataset.editController)
  if (!controller) {
    showNotice('Controller configuration could not be loaded.', true)
    return
  }

  controllerForm.dataset.oid = controller.OID
  controllerForm.elements.name.value = controller.name || ''
  controllerForm.elements.deviceID.value = controller.deviceID || ''
  controllerForm.elements.address.value = controller.address?.configured || controller.address?.address || ''
  controllerForm.elements.protocol.value = controller.protocol === 'tcp' ? 'tcp' : 'udp'
  controllerForm.elements.datetime.value = controllerDateTimeValue(controller.datetime?.datetime)
  controllerForm.elements.interlock.value = controller.interlock || '0'
  controllerForm.elements.antipassback.value = controller.antipassback?.antipassback || '0'
  document.getElementById('controller-editor-title').textContent = controller.name || `Controller ${controller.deviceID}`
  renderControllerDoors(controller)

  controllerDialog.showModal()
}

function localDateTimeValue() {
  const now = new Date()
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 19)
}

function controllerDateTimeValue(value) {
  const match = `${value || ''}`.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?/)
  return match ? `${match[1]}T${match[2]}:${match[3] || '00'}` : localDateTimeValue()
}

async function setControllerTime() {
  const oid = controllerForm.dataset.oid
  const datetime = controllerForm.elements.datetime.value
  if (!oid || !datetime) {
    showNotice('Choose a controller date and time first.', true)
    return
  }
  const button = document.getElementById('controller-time-set')
  button.disabled = true
  try {
    const response = await fetch('/api/v1/controllers/time', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ controller: oid, datetime }),
    })
    if (!response.ok) throw new Error((await response.text()) || `Controller time update failed (${response.status})`)
    showNotice('Controller date and time update sent.')
  } catch (error) {
    showNotice(error.message || 'Controller time update failed.', true)
  } finally {
    button.disabled = false
  }
}

async function saveController(event) {
  event.preventDefault()
  const oid = controllerForm.dataset.oid
  const controller = DB.controllers.get(oid)
  if (!controller) return

  const updates = []
  const changed = (suffix, value, original) => {
    if (`${value ?? ''}` !== `${original ?? ''}`) updates.push({ oid: `${oid}${suffix}`, value: `${value ?? ''}` })
  }

  changed(schema.controllers.name, controllerForm.elements.name.value.trim(), controller.name)
  changed(schema.controllers.deviceID, controllerForm.elements.deviceID.value.trim(), controller.deviceID)
  changed(schema.controllers.endpoint.address, controllerForm.elements.address.value.trim(), controller.address?.configured)
  changed(schema.controllers.endpoint.protocol, controllerForm.elements.protocol.value, controller.protocol)
  changed(schema.controllers.interlock, controllerForm.elements.interlock.value, controller.interlock)
  changed(schema.controllers.antipassback.antipassback, controllerForm.elements.antipassback.value, controller.antipassback?.antipassback)

  for (let channel = 1; channel <= 4; channel += 1) {
    const field = controllerForm.elements[`door${channel}`]
    if (field) changed(schema.controllers[`door${channel}`], field.value, controller.doors?.[channel])
  }

  if (!updates.length) {
    controllerDialog.close()
    return
  }

  const saveButton = document.getElementById('controller-editor-save')
  saveButton.disabled = true
  try {
    const response = await fetch('/controllers', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ created: [], updated: updates, deleted: [] }),
    })
    if (!response.ok) throw new Error((await response.text()) || `Controller update failed (${response.status})`)
    await synchronizeHardware('/synchronize/doors', 'Relay')
    await synchronizeHardware('/synchronize/ACL', 'Card')
    controllerDialog.close()
    showNotice('Controller configuration saved and synchronized.')
    await load()
  } catch (error) {
    showNotice(error.message || 'Controller update failed.', true)
  } finally {
    saveButton.disabled = false
  }
}

async function load() {
  if (loading) return
  loading = true
  document.getElementById('refresh-button').disabled = true
  showNotice('')
  try {
    const response = await fetch('/api/v1/snapshot', { credentials: 'same-origin', cache: 'no-store' })
    if (response.status === 401) {
      window.location = '/sys/login.html'
      return
    }
    if (!response.ok) throw new Error((await response.text()) || `Request failed (${response.status})`)
    const snapshot = await response.json()
    const snapshotHasCards = (snapshot.cards || []).some((item) => schema.cards.regex.test(`${item.OID || ''}`))
    const retainCards = currentRoute() === 'cards' && records(DB.cards).length > 0 && !snapshotHasCards && emptyCardRetries < 4
    for (const [name, values] of Object.entries(snapshot)) {
      if (!(retainCards && name === 'cards')) DB.replace(name, values)
    }
    setConnection(true, config.mode === 'monitor' ? 'Monitor mode' : 'System online')
    render()
    if (retainCards || (currentRoute() === 'cards' && records(DB.cards).length === 0 && emptyCardRetries < 4)) {
      emptyCardRetries += 1
      clearTimeout(emptyCardRetryTimer)
      emptyCardRetryTimer = setTimeout(load, emptyCardRetries * 500)
    } else if (records(DB.cards).length > 0) {
      emptyCardRetries = 0
      clearTimeout(emptyCardRetryTimer)
    }
  } catch (error) {
    setConnection(false, 'System unavailable')
    showNotice(error.message || 'Unable to load access-control data.', true)
    if (!app.children.length || app.querySelector('.loading-card')) app.innerHTML = empty('Access Control - HTTP could not load system data. Use Refresh to try again.')
  } finally {
    loading = false
    document.getElementById('refresh-button').disabled = false
  }
}

async function manualRefresh() {
  const button = document.getElementById('refresh-button')
  button.disabled = true
  button.textContent = 'Refreshing...'
  showNotice('Refreshing controller and access-control data...')
  try {
    const now = new Date()
    const localDateTime = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 19)
    const response = await fetch('/api/v1/refresh', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ datetime: localDateTime }),
    })
    if (!response.ok) throw new Error((await response.text()) || `Refresh failed (${response.status})`)
    await load()
    showNotice('Controller data and clock refreshed.')
  } catch (error) {
    showNotice(error.message || 'Refresh failed.', true)
  } finally {
    button.disabled = false
    button.textContent = 'Refresh'
  }
}

async function controlDoor(event) {
  const button = event.currentTarget
  const buttons = button.closest('.door-actions').querySelectorAll('button')
  buttons.forEach((item) => { item.disabled = true })
  try {
    const response = await fetch('/api/v1/doors/control', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(button.dataset.door
        ? { door: button.dataset.door, mode: button.dataset.mode }
        : { controller: button.dataset.controller, channel: Number(button.dataset.channel), mode: button.dataset.mode }),
    })
    if (!response.ok) throw new Error((await response.text()) || `Door control failed (${response.status})`)
    showNotice(`Door command accepted: ${button.dataset.mode}.`)
    await load()
  } catch (error) {
    showNotice(error.message || 'Door control failed.', true)
  } finally {
    buttons.forEach((item) => { item.disabled = config.mode === 'monitor' })
  }
}

document.getElementById('refresh-button').addEventListener('click', manualRefresh)
controllerForm.addEventListener('submit', saveController)
doorForm.addEventListener('submit', saveDoor)
cardForm.addEventListener('submit', saveCard)
personForm.addEventListener('submit', savePerson)
credentialBulkForm.addEventListener('submit', saveBulkCredentialAccess)
cardForm.elements.managementGroup.addEventListener('change', () => updateManagementGroupNewField(cardForm))
personForm.elements.managementGroup.addEventListener('change', () => updateManagementGroupNewField(personForm))
cardForm.elements.number.addEventListener('input', () => populateFacilityCard(cardForm.elements.number.value))
cardForm.elements.name.addEventListener('change', useExistingPersonGroup)
cardForm.elements.facilityCode.addEventListener('input', populateDecimalCard)
cardForm.elements.cardNumber.addEventListener('input', populateDecimalCard)
cardForm.elements.from.addEventListener('change', () => updateValidUntil({ forceDefault: cardForm.dataset.untilAutomatic === 'true' }))
cardForm.elements.to.addEventListener('change', () => {
  cardForm.dataset.untilAutomatic = 'false'
  updateValidUntil()
})
groupForm.addEventListener('submit', saveGroup)
groupForm.elements.scheduleEnabled.addEventListener('change', () => {
  document.getElementById('group-schedule-fields').classList.toggle('hidden', !groupForm.elements.scheduleEnabled.checked)
})
doorForm.elements.controller.addEventListener('change', () => refreshDoorChannels())
document.getElementById('controller-editor-close').addEventListener('click', () => controllerDialog.close())
document.getElementById('controller-editor-cancel').addEventListener('click', () => controllerDialog.close())
document.getElementById('controller-time-now').addEventListener('click', () => { controllerForm.elements.datetime.value = localDateTimeValue() })
document.getElementById('controller-time-set').addEventListener('click', setControllerTime)
document.getElementById('door-editor-close').addEventListener('click', () => {
  doorDialog.close()
  delete doorDialog.dataset.returnController
})
document.getElementById('door-editor-cancel').addEventListener('click', () => {
  doorDialog.close()
  delete doorDialog.dataset.returnController
})
document.getElementById('door-editor-delete').addEventListener('click', deleteDoor)
document.getElementById('card-editor-close').addEventListener('click', () => cardDialog.close())
document.getElementById('card-editor-cancel').addEventListener('click', () => cardDialog.close())
document.getElementById('card-editor-delete').addEventListener('click', deleteCard)
document.getElementById('credential-bulk-close').addEventListener('click', () => credentialBulkDialog.close())
document.getElementById('credential-bulk-cancel').addEventListener('click', () => credentialBulkDialog.close())
document.getElementById('person-editor-close').addEventListener('click', () => personDialog.close())
document.getElementById('person-editor-cancel').addEventListener('click', () => personDialog.close())
document.getElementById('card-group-add').addEventListener('click', () => editGroup({ currentTarget: { dataset: { fromCard: 'true' } } }))
document.getElementById('group-editor-close').addEventListener('click', () => groupDialog.close())
document.getElementById('group-editor-cancel').addEventListener('click', () => groupDialog.close())
document.getElementById('group-editor-delete').addEventListener('click', deleteGroup)
document.getElementById('backup-create').addEventListener('click', createBackup)
document.getElementById('backup-file').addEventListener('change', importBackup)
document.getElementById('controller-import-apply').addEventListener('click', applyControllerImport)
document.getElementById('menu-button').addEventListener('click', () => document.getElementById('sidebar').classList.toggle('open'))
document.getElementById('signout-button').addEventListener('click', async () => {
  await fetch('/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  window.location = '/sys/login.html'
})

load()
setInterval(load, 15000)
