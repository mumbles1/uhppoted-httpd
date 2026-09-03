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
const groupDialog = document.getElementById('group-dialog')
const groupForm = document.getElementById('group-form')
const routes = ['overview', 'controllers', 'doors', 'cards', 'groups', 'events', 'logs']

let loading = false
let emptyCardRetries = 0
let emptyCardRetryTimer = null
let groupSearch = ''

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
}

function updateNavigation() {
  const route = currentRoute()
  document.querySelectorAll('[data-route]').forEach((link) => link.classList.toggle('active', link.dataset.route === route))
  document.getElementById('page-title').textContent = route === 'overview' ? 'Overview' : route === 'logs' ? 'Audit log' : route === 'doors' ? 'Relays' : route[0].toUpperCase() + route.slice(1)

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

function panel(title, subtitle, headers, rows) {
  if (!rows.length) return `<section class="panel"><div class="panel-heading"><div><h2>${escapeHTML(title)}</h2><p>${escapeHTML(subtitle)}</p></div></div>${empty(`No ${title.toLowerCase()} are available.`)}</section>`
  return `<section class="panel">
    <div class="panel-heading"><div><h2>${escapeHTML(title)}</h2><p>${escapeHTML(subtitle)}</p></div></div>
    <div class="table-wrap"><table><thead><tr>${headers.map((header) => `<th>${escapeHTML(header)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>
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
    return `<tr>
      <td class="name-cell"><strong>${display(doorName)}</strong><small>${display(controllerName)}${controller?.deviceID ? ` · ${escapeHTML(controller.deviceID)}` : ''}</small></td>
      <td>${display(({ 'normally open': 'Open', 'normally closed': 'Close', controlled: 'Controlled' })[door?.mode?.mode] || door?.mode?.mode, door ? 'Unknown' : 'Not configured')}</td>
      <td>${door ? `${display(door.delay?.delay, '0')}s` : '—'}</td>
      <td>${door ? (door.keypad ? 'Enabled' : 'Disabled') : '—'}</td>
      <td>${statusBadge(door?.mode?.status || door?.status || controller?.status)}</td>
      <td><div class="door-actions">
        <button class="primary" ${target} data-mode="normally open" ${disabled}>Open</button>
        <button class="secondary" ${target} data-mode="controlled" ${disabled}>Controlled</button>
        <button class="danger" ${target} data-mode="normally closed" ${disabled}>Close</button>
      </div></td>
    </tr>`
  })
}

function cardRows(list = records(DB.cards)) {
  return list.map((card) => {
    const memberships = [...(card.groups?.values?.() || [])].filter((group) => group.member).length
    const credential = formatCredential(card.number)
    return `<tr>
      <td class="name-cell"><strong>${display(card.name, 'Unnamed cardholder')}</strong><small>${display(card.OID)}</small></td>
      <td>${credential ? `<span class="name-cell"><strong>FC ${credential.facilityCode} · CD ${credential.cardNumber}</strong><small>Controller ID ${escapeHTML(credential.raw)}</small></span>` : display(card.number)}</td><td>${display(card.from)}</td><td>${display(card.to)}</td><td>${memberships}</td><td>${statusBadge(card.status)}</td>
      <td><button class="secondary" data-edit-card="${escapeHTML(card.OID)}" ${config.mode === 'monitor' ? 'disabled' : ''}>Configure</button></td>
    </tr>`
  })
}

function groupRows(list = records(DB.groups)) {
  return list.map((group) => {
    const permitted = [...(group.doors?.values?.() || [])].filter((door) => door.allowed).length
    return `<tr><td class="name-cell"><strong>${display(group.name, 'Unnamed group')}</strong><small>${display(group.OID)}</small></td><td>${permitted}</td><td>${group.firstcard ? 'Yes' : 'No'}</td><td>${statusBadge(group.status)}</td><td><button class="secondary" data-edit-group="${escapeHTML(group.OID)}" ${config.mode === 'monitor' ? 'disabled' : ''}>Configure</button></td></tr>`
  })
}

function filterGroups(event) {
  groupSearch = event.currentTarget.value
  const query = groupSearch.trim().toLowerCase()
  const groups = records(DB.groups).filter((group) => !query || `${group.name} ${group.OID}`.toLowerCase().includes(query))
  const body = app.querySelector('tbody')
  if (!body) return
  body.innerHTML = groups.length ? groupRows(groups).join('') : '<tr><td colspan="5">No groups match your search.</td></tr>'
  body.querySelectorAll('[data-edit-group]').forEach((button) => button.addEventListener('click', editGroup))
}

function eventRows(list = records(DB.events())) {
  return list.sort((a, b) => `${b.timestamp}`.localeCompare(`${a.timestamp}`)).map((event) => `<tr>
    <td>${display(formatEventTime(event.timestamp))}</td><td>${display(event.deviceName, event.deviceID)}</td><td>${display(event.doorName, event.door)}</td><td>${eventCard(event)}</td><td>${event.granted === 'true' ? '<span class="badge">Granted</span>' : '<span class="badge warn">Denied</span>'}</td><td>${display(event.reason, event.eventType)}</td>
  </tr>`)
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
  if (number && number !== '0') return `<span class="name-cell"><strong>Card ${escapeHTML(number)}</strong></span>`
  return display(number && number !== '0' ? number : '', '—')
}

function formatCredential(value) {
  const wiegand = decodeWiegand26(value)
  if (!wiegand || `${value}`.trim() === '0') return null
  return { raw: `${value}`.trim(), ...wiegand }
}

function decodeWiegand26(value) {
  const raw = `${value ?? ''}`.trim()
  if (!raw) return null
  const number = Number(raw)
  if (!Number.isSafeInteger(number) || number < 0 || number > 0xffffff) return null
  return { facilityCode: Math.floor(number / 65536), cardNumber: number % 65536 }
}

function populateFacilityCard(value) {
  const wiegand = decodeWiegand26(value)
  cardForm.elements.facilityCode.value = wiegand?.facilityCode ?? ''
  cardForm.elements.cardNumber.value = wiegand?.cardNumber ?? ''
}

function populateDecimalCard() {
  const facilityCode = cardForm.elements.facilityCode.value
  const cardNumber = cardForm.elements.cardNumber.value
  if (facilityCode === '' || cardNumber === '') return
  const fc = Number(facilityCode)
  const cn = Number(cardNumber)
  if (Number.isInteger(fc) && fc >= 0 && fc <= 255 && Number.isInteger(cn) && cn >= 0 && cn <= 65535) {
    cardForm.elements.number.value = `${fc * 65536 + cn}`
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
  return `<div class="stats">
    <div class="stat"><span>Controllers</span><strong>${controllers.length}</strong></div>
    <div class="stat"><span>Relays</span><strong>${doors.length}</strong></div>
    <div class="stat"><span>Active cards</span><strong>${cards.length}</strong></div>
    <div class="stat"><span>Access groups</span><strong>${groups.length}</strong></div>
  </div>
  <div class="two-column">
    ${panel('Controllers', 'Connected access-control hardware', ['Controller', 'ID', 'Protocol', 'Cards', 'Events', 'Status', ''], controllerRows(controllers))}
    ${panel('Recent events', 'Latest controller activity', ['Time', 'Controller', 'Door', 'Card', 'Access', 'Reason'], eventRows().slice(0, 8))}
  </div>`
}

function render() {
  updateNavigation()
  switch (currentRoute()) {
    case 'controllers': app.innerHTML = panel('Controllers', 'Controller health and configuration', ['Controller', 'ID', 'Protocol', 'Cards', 'Events', 'Status', ''], controllerRows()); break
    case 'doors': app.innerHTML = panel('Relays', config.mode === 'monitor' ? 'Monitor mode — controls are disabled' : 'Live relay state and controls', ['Relay / door', 'Mode', 'Delay', 'Keypad', 'Status', 'Controls'], doorRows()); break
    case 'cards': app.innerHTML = panel('Cards', 'Cardholders and validity periods', ['Cardholder', 'Card number', 'Valid from', 'Valid to', 'Groups', 'Status', ''], cardRows()); break
    case 'groups': app.innerHTML = panel('Groups', 'Relay access assignments', ['Group', 'Relays', 'First-card', 'Status', ''], groupRows()); break
    case 'events': app.innerHTML = panel('Events', 'Recent controller events', ['Time', 'Controller', 'Door', 'Card', 'Access', 'Reason'], eventRows()); break
    case 'logs': app.innerHTML = panel('Audit log', 'Recent configuration changes', ['Time', 'User', 'Item', 'Details'], logRows()); break
    default: app.innerHTML = overview()
  }

  if (currentRoute() === 'cards') {
    app.querySelector('.panel-heading')?.insertAdjacentHTML('beforeend', `<button class="primary" data-add-card ${config.mode === 'monitor' ? 'disabled' : ''}>Add card</button>`)
  }
  if (currentRoute() === 'groups') {
    app.querySelector('.panel-heading')?.insertAdjacentHTML('beforeend', `<div class="panel-tools"><input class="panel-search" data-group-search type="search" placeholder="Search groups" aria-label="Search groups" value="${escapeHTML(groupSearch)}"><button class="primary" data-add-group ${config.mode === 'monitor' ? 'disabled' : ''}>Add access group</button></div>`)
  }

  document.querySelectorAll('[data-mode][data-door], [data-mode][data-controller][data-channel]').forEach((button) => button.addEventListener('click', controlDoor))
  document.querySelectorAll('[data-edit-controller]').forEach((button) => button.addEventListener('click', editController))
  document.querySelectorAll('[data-add-door], [data-edit-door]').forEach((button) => button.addEventListener('click', editDoor))
  document.querySelectorAll('[data-add-card], [data-edit-card]').forEach((button) => button.addEventListener('click', editCard))
  document.querySelectorAll('[data-add-group], [data-edit-group]').forEach((button) => button.addEventListener('click', editGroup))
  document.querySelector('[data-group-search]')?.addEventListener('input', filterGroups)
  if (currentRoute() === 'groups' && groupSearch) filterGroups({ currentTarget: { value: groupSearch } })
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
  const groups = records(DB.groups)
  document.getElementById('card-group-fields').innerHTML = groups.length
    ? groups.map((group) => {
      const checked = selected ? selected.has(group.OID) : cardInGroup(card, group)
      return `<label class="choice"><input type="checkbox" data-card-group="${escapeHTML(group.OID)}" ${checked ? 'checked' : ''}><span>${display(group.name, `Group ${group.OID}`)}</span></label>`
    }).join('')
    : empty('No access groups are available. Add one here, then assign it to this card.')
}

function defaultCardDates() {
  const from = new Date()
  const to = new Date(from)
  to.setFullYear(to.getFullYear() + 1)
  const format = (date) => `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}-${`${date.getDate()}`.padStart(2, '0')}`
  return { from: format(from), to: format(to) }
}

function editCard(event) {
  const card = event.currentTarget.dataset.editCard ? DB.cards.get(event.currentTarget.dataset.editCard) : null
  const defaults = defaultCardDates()
  cardForm.dataset.oid = card?.OID || ''
  cardForm.elements.name.value = card?.name || ''
  cardForm.elements.number.value = card?.number || ''
  populateFacilityCard(card?.number)
  cardForm.elements.PIN.value = card?.PIN || ''
  cardForm.elements.from.value = card?.from || defaults.from
  cardForm.elements.to.value = card?.to || defaults.to

  renderCardGroups(card)

  document.getElementById('card-editor-title').textContent = card ? (card.name || 'Configure card') : 'Add card'
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
    : empty('No configured relays are available yet. You can save the group and assign relays later.')
}

function editGroup(event) {
  const group = event.currentTarget.dataset.editGroup ? DB.groups.get(event.currentTarget.dataset.editGroup) : null
  groupForm.dataset.oid = group?.OID || ''
  groupForm.elements.name.value = group?.name || ''
  groupForm.elements.firstcard.checked = Boolean(group?.firstcard)
  groupDialog.dataset.returnCard = event.currentTarget.dataset.fromCard === 'true' ? 'true' : ''
  if (groupDialog.dataset.returnCard) groupDialog.dataset.cardSelections = JSON.stringify([...selectedCardGroups()])
  else delete groupDialog.dataset.cardSelections
  renderGroupDoors(group)
  document.getElementById('group-editor-title').textContent = group ? (group.name || 'Configure access group') : 'Add access group'
  document.getElementById('group-editor-delete').classList.toggle('hidden', !group)
  groupDialog.showModal()
}

async function refreshGroupData() {
  const response = await fetch('/api/v1/snapshot', { credentials: 'same-origin', cache: 'no-store' })
  if (!response.ok) throw new Error((await response.text()) || `Unable to refresh groups (${response.status})`)
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
    if (records(DB.groups).some((group) => group.OID !== oid && `${group.name}`.trim().toLowerCase() === name.toLowerCase())) {
      throw new Error('An access group with that name already exists.')
    }
    if (!oid) {
      const created = await postConfiguration('/groups', { created: [{ oid: '<new>', value: '' }], updated: [], deleted: [] })
      oid = created.groups?.find((item) => item.value === 'new')?.OID
      if (!oid) throw new Error('The server did not return the new group ID.')
    }

    const updates = []
    const changed = (suffix, value, original) => {
      if (!existing || `${value ?? ''}` !== `${original ?? ''}`) updates.push({ oid: `${oid}${suffix}`, value: `${value ?? ''}` })
    }
    changed(schema.groups.name, name, existing?.name)
    changed(schema.groups.firstcard, `${groupForm.elements.firstcard.checked}`, `${Boolean(existing?.firstcard)}`)
    for (const door of records(DB.doors)) {
      const permissionOID = groupDoorOID(oid, door.OID)
      const selected = Boolean(document.querySelector(`[data-group-door="${door.OID}"]`)?.checked)
      if (permissionOID && (!existing || selected !== groupAllowsDoor(existing, door.OID))) updates.push({ oid: permissionOID, value: `${selected}` })
    }
    if (updates.length) await postConfiguration('/groups', { created: [], updated: updates, deleted: [] })
    await refreshGroupData()

    const returnCard = groupDialog.dataset.returnCard === 'true'
    const selections = new Set(JSON.parse(groupDialog.dataset.cardSelections || '[]'))
    selections.add(oid)
    groupDialog.close()
    if (returnCard && cardDialog.open) {
      const card = cardForm.dataset.oid ? DB.cards.get(cardForm.dataset.oid) : null
      renderCardGroups(card, selections)
      showNotice('Access group created and selected. Save the card to apply its access.')
    } else {
      showNotice(existing ? 'Access group saved. Save or update cards to apply membership changes.' : 'Access group added.')
      render()
    }
  } catch (error) {
    showNotice(error.message || 'Access group configuration failed.', true)
  } finally {
    saveButton.disabled = false
  }
}

async function deleteGroup() {
  const oid = groupForm.dataset.oid
  const group = oid ? DB.groups.get(oid) : null
  if (!group) return
  const name = group.name || `Group ${oid}`
  if (!window.confirm(`Delete ${name}? Cards assigned only to this group will lose access.`)) return

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
    showNotice(`${name} deleted and card access synchronized.`)
    await load()
  } catch (error) {
    showNotice(error.message || 'Access group deletion failed.', true)
  } finally {
    deleteButton.disabled = false
    saveButton.disabled = false
  }
}

async function currentCardOID(card) {
  if (!card?.number) return card?.OID || ''

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch('/api/v1/snapshot', { credentials: 'same-origin', cache: 'no-store' })
    if (!response.ok) throw new Error((await response.text()) || `Unable to refresh cards (${response.status})`)
    const snapshot = await response.json()
    const number = (snapshot.cards || []).find((item) => {
      const match = `${item.OID || ''}`.match(schema.cards.regex)
      return match && `${item.OID}` === `${match[1]}${schema.cards.card}` && `${item.value}` === `${card.number}`
    })
    const match = `${number?.OID || ''}`.match(schema.cards.regex)
    if (match) return match[1]
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)))
  }

  throw new Error('The card list is refreshing. Please save again in a moment.')
}

async function saveCard(event) {
  event.preventDefault()
  const saveButton = document.getElementById('card-editor-save')
  saveButton.disabled = true
  let oid = cardForm.dataset.oid
  const existing = oid ? DB.cards.get(oid) : null

  try {
    if (cardForm.elements.to.value < cardForm.elements.from.value) throw new Error('Valid until must be on or after Valid from.')
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
    changed(schema.cards.name, cardForm.elements.name.value.trim(), existing?.name)
    changed(schema.cards.card, cardForm.elements.number.value.trim(), existing?.number)
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
        throw new Error('The card changed while it was being saved. Please try again.')
      }
      await synchronizeHardware('/synchronize/ACL', 'Card')
    }

    cardDialog.close()
    showNotice(existing ? 'Card configuration saved and synchronized.' : 'Card added and synchronized.')
    await load()
  } catch (error) {
    showNotice(error.message || 'Card configuration failed.', true)
  } finally {
    saveButton.disabled = false
  }
}

async function deleteCard() {
  const oid = cardForm.dataset.oid
  const card = oid ? DB.cards.get(oid) : null
  if (!card) return
  const name = card.name || `Card ${card.number || oid}`
  if (!window.confirm(`Delete ${name}? This revokes all group access and cannot be undone.`)) return

  const deleteButton = document.getElementById('card-editor-delete')
  const saveButton = document.getElementById('card-editor-save')
  deleteButton.disabled = true
  saveButton.disabled = true
  try {
    await postConfiguration('/cards', { created: [], updated: [], deleted: [oid] })
    await synchronizeHardware('/synchronize/ACL', 'Card')
    cardDialog.close()
    showNotice(`${name} deleted and synchronized.`)
    await load()
  } catch (error) {
    showNotice(error.message || 'Card deletion failed.', true)
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
    await new Promise((resolve) => setTimeout(resolve, 1200))
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
cardForm.elements.number.addEventListener('input', () => populateFacilityCard(cardForm.elements.number.value))
cardForm.elements.facilityCode.addEventListener('input', populateDecimalCard)
cardForm.elements.cardNumber.addEventListener('input', populateDecimalCard)
groupForm.addEventListener('submit', saveGroup)
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
document.getElementById('card-group-add').addEventListener('click', () => editGroup({ currentTarget: { dataset: { fromCard: 'true' } } }))
document.getElementById('group-editor-close').addEventListener('click', () => groupDialog.close())
document.getElementById('group-editor-cancel').addEventListener('click', () => groupDialog.close())
document.getElementById('group-editor-delete').addEventListener('click', deleteGroup)
document.getElementById('menu-button').addEventListener('click', () => document.getElementById('sidebar').classList.toggle('open'))
document.getElementById('signout-button').addEventListener('click', async () => {
  await fetch('/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  window.location = '/sys/login.html'
})

load()
setInterval(load, 15000)
