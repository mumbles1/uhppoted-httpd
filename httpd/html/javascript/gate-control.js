import { DB, alive } from './db.js'

const config = window.gateControl || {}
const app = document.getElementById('app')
const notice = document.getElementById('notice')
const connectionDot = document.getElementById('connection-dot')
const connectionLabel = document.getElementById('connection-label')
const routes = ['overview', 'controllers', 'doors', 'cards', 'groups', 'events', 'logs']

let loading = false

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
  document.getElementById('page-title').textContent = route === 'overview' ? 'Overview' : route === 'logs' ? 'Audit log' : route[0].toUpperCase() + route.slice(1)

  const counts = {
    overview: records(DB.controllers).length + records(DB.doors).length,
    controllers: records(DB.controllers).length,
    doors: records(DB.doors).length,
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
  </tr>`)
}

function controllerForDoor(doorOID) {
  return records(DB.controllers).find((controller) => Object.values(controller.doors || {}).includes(doorOID))
}

function doorRows(list = records(DB.doors)) {
  return list.map((door) => {
    const controller = controllerForDoor(door.OID)
    const disabled = config.mode === 'monitor' ? 'disabled' : ''
    return `<tr>
      <td class="name-cell"><strong>${display(door.name, 'Unnamed door')}</strong><small>${display(controller?.name, controller?.deviceID ? `Controller ${controller.deviceID}` : 'Unassigned')}</small></td>
      <td>${display(door.mode?.mode)}</td>
      <td>${display(door.delay?.delay, '0')}s</td>
      <td>${door.keypad ? 'Enabled' : 'Disabled'}</td>
      <td>${statusBadge(door.mode?.status || door.status)}</td>
      <td><div class="door-actions">
        <button class="primary" data-door="${escapeHTML(door.OID)}" data-mode="normally open" ${disabled}>Unlock</button>
        <button class="secondary" data-door="${escapeHTML(door.OID)}" data-mode="controlled" ${disabled}>Controlled</button>
        <button class="danger" data-door="${escapeHTML(door.OID)}" data-mode="normally closed" ${disabled}>Lock</button>
      </div></td>
    </tr>`
  })
}

function cardRows(list = records(DB.cards)) {
  return list.map((card) => {
    const memberships = [...(card.groups?.values?.() || [])].filter((group) => group.member).length
    return `<tr>
      <td class="name-cell"><strong>${display(card.name, 'Unnamed cardholder')}</strong><small>${display(card.OID)}</small></td>
      <td>${display(card.number)}</td><td>${display(card.from)}</td><td>${display(card.to)}</td><td>${memberships}</td><td>${statusBadge(card.status)}</td>
    </tr>`
  })
}

function groupRows(list = records(DB.groups)) {
  return list.map((group) => {
    const permitted = [...(group.doors?.values?.() || [])].filter((door) => door.allowed).length
    return `<tr><td class="name-cell"><strong>${display(group.name, 'Unnamed group')}</strong><small>${display(group.OID)}</small></td><td>${permitted}</td><td>${group.firstcard ? 'Yes' : 'No'}</td><td>${statusBadge(group.status)}</td></tr>`
  })
}

function eventRows(list = records(DB.events())) {
  return list.sort((a, b) => `${b.timestamp}`.localeCompare(`${a.timestamp}`)).map((event) => `<tr>
    <td>${display(event.timestamp)}</td><td>${display(event.deviceName, event.deviceID)}</td><td>${display(event.doorName, event.door)}</td><td>${display(event.cardName, event.card)}</td><td>${event.granted === 'true' ? '<span class="badge">Granted</span>' : '<span class="badge warn">Denied</span>'}</td><td>${display(event.reason, event.eventType)}</td>
  </tr>`)
}

function logRows(list = records(DB.logs())) {
  return list.sort((a, b) => `${b.timestamp}`.localeCompare(`${a.timestamp}`)).map((entry) => `<tr><td>${display(entry.timestamp)}</td><td>${display(entry.uid)}</td><td>${display(entry.item?.type)}</td><td>${display(entry.item?.details)}</td></tr>`)
}

function overview() {
  const controllers = records(DB.controllers)
  const doors = records(DB.doors)
  const cards = records(DB.cards)
  const groups = records(DB.groups)
  return `<div class="stats">
    <div class="stat"><span>Controllers</span><strong>${controllers.length}</strong></div>
    <div class="stat"><span>Doors</span><strong>${doors.length}</strong></div>
    <div class="stat"><span>Active cards</span><strong>${cards.length}</strong></div>
    <div class="stat"><span>Access groups</span><strong>${groups.length}</strong></div>
  </div>
  <div class="two-column">
    ${panel('Controllers', 'Connected access-control hardware', ['Controller', 'ID', 'Protocol', 'Cards', 'Events', 'Status'], controllerRows(controllers))}
    ${panel('Recent events', 'Latest controller activity', ['Time', 'Controller', 'Door', 'Card', 'Access', 'Reason'], eventRows().slice(0, 8))}
  </div>`
}

function render() {
  updateNavigation()
  switch (currentRoute()) {
    case 'controllers': app.innerHTML = panel('Controllers', 'Controller health and configuration', ['Controller', 'ID', 'Protocol', 'Cards', 'Events', 'Status'], controllerRows()); break
    case 'doors': app.innerHTML = panel('Doors', config.mode === 'monitor' ? 'Monitor mode — controls are disabled' : 'Live door state and controls', ['Door', 'Mode', 'Delay', 'Keypad', 'Status', 'Controls'], doorRows()); break
    case 'cards': app.innerHTML = panel('Cards', 'Cardholders and validity periods', ['Cardholder', 'Card number', 'Valid from', 'Valid to', 'Groups', 'Status'], cardRows()); break
    case 'groups': app.innerHTML = panel('Groups', 'Door access assignments', ['Group', 'Doors', 'First-card', 'Status'], groupRows()); break
    case 'events': app.innerHTML = panel('Events', 'Recent controller events', ['Time', 'Controller', 'Door', 'Card', 'Access', 'Reason'], eventRows()); break
    case 'logs': app.innerHTML = panel('Audit log', 'Recent configuration changes', ['Time', 'User', 'Item', 'Details'], logRows()); break
    default: app.innerHTML = overview()
  }

  document.querySelectorAll('[data-door][data-mode]').forEach((button) => button.addEventListener('click', controlDoor))
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
    for (const [name, values] of Object.entries(snapshot)) DB.updated(name, values)
    setConnection(true, config.mode === 'monitor' ? 'Monitor mode' : 'System online')
    render()
  } catch (error) {
    setConnection(false, 'System unavailable')
    showNotice(error.message || 'Unable to load access-control data.', true)
    if (!app.children.length || app.querySelector('.loading-card')) app.innerHTML = empty('Gate Control could not load system data. Use Refresh to try again.')
  } finally {
    loading = false
    document.getElementById('refresh-button').disabled = false
  }
}

async function controlDoor(event) {
  const button = event.currentTarget
  const buttons = button.closest('.door-actions').querySelectorAll('button')
  buttons.forEach((item) => { item.disabled = true })
  try {
    const response = await fetch('/api/v1/doors/control', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ door: button.dataset.door, mode: button.dataset.mode }),
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

document.getElementById('refresh-button').addEventListener('click', load)
document.getElementById('menu-button').addEventListener('click', () => document.getElementById('sidebar').classList.toggle('open'))
document.getElementById('signout-button').addEventListener('click', async () => {
  await fetch('/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  window.location = '/sys/login.html'
})

load()
setInterval(load, 15000)
