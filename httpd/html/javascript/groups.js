import { update, trim } from './tabular.js'
import { DB, alive } from './db.js'
import { schema } from './schema.js'
import { loaded } from './uhppoted.js'

export function refreshed() {
  const groups = [...DB.groups.values()].filter((g) => alive(g)).sort((p, q) => p.created.localeCompare(q.created))

  realize(groups)

  groups.forEach((o) => {
    const row = updateFromDB(o.OID, o)
    if (row) {
      if (o.status === 'new') {
        row.classList.add('new')
      } else {
        row.classList.remove('new')
      }
    }
  })

  loaded()
}

export function deletable(row) {
  const name = row.querySelector('td input.name')
  const re = /^\s*$/

  if (name && name.dataset.oid !== '' && re.test(name.dataset.value)) {
    return true
  }

  return false
}

function realize(groups) {
  const table = document.querySelector('#groups table')
  const thead = table.tHead
  const tbody = table.tBodies[0]

  const doors = new Map(
    [...DB.doors.values()]
      .filter((o) => o.status && o.status !== '<new>' && alive(o))
      .sort((p, q) => p.created.localeCompare(q.created))
      .map((o) => [o.OID, o]),
  )

  // ... columns
  const columns = table.querySelectorAll('th.door')
  const cols = new Map([...columns].map((c) => [c.dataset.door, c]))
  const missing = [...doors.values()].filter((o) => o.OID === '' || !cols.has(o.OID))
  const surplus = [...cols].filter(([k]) => !doors.has(k))

  missing.forEach((o) => {
    const padding = thead.rows[0].lastElementChild
    const firstcard = padding.previousElementSibling
    const th = document.createElement('th')

    th.classList.add('colheader')
    th.classList.add('door')
    th.dataset.door = o.OID
    th.innerText = o.name

    thead.rows[0].insertBefore(th, firstcard)
  })

  surplus.forEach(([, v]) => {
    v.remove()
  })

  // ... rows
  trim('groups', groups, tbody.querySelectorAll('tr.group'))

  groups.forEach((o) => {
    let row = tbody.querySelector("tr[data-oid='" + o.OID + "']")

    if (!row) {
      row = add(o.OID, o)
    }

    const columns = row.querySelectorAll('td.door')
    const cols = new Map([...columns].map((c) => [c.dataset.door, c]))
    const missing = [...doors.values()].filter((o) => o.OID === '' || !cols.has(o.OID))
    const surplus = [...cols].filter(([k]) => !doors.has(k))

    missing.forEach((o) => {
      const door = o.OID.match(schema.doors.regex)[2]
      const padding = row.lastElementChild
      const firstcard = padding.previousElementSibling
      const template = document.querySelector('#door')
      const clone = document.importNode(template.content, true)

      const uuid = row.id
      const oid = `${row.dataset.oid}${schema.groups.door}.${door}`
      const cell = document.createElement('td')
      const field = clone.querySelector('.field')

      cell.classList.add('door')
      cell.dataset.door = o.OID

      field.id = uuid + '-' + `d${door}`
      field.checked = false

      field.dataset.oid = oid
      field.dataset.record = uuid
      field.dataset.original = ''
      field.dataset.value = ''

      cell.appendChild(clone)
      firstcard.insertAdjacentElement('beforebegin', cell)
    })

    surplus.forEach(([, v]) => {
      v.remove()
    })
  })
}

function add(oid, _record) {
  const uuid = 'R' + oid.replaceAll(/[^0-9]/g, '')
  const tbody = document.getElementById('groups').querySelector('table tbody')

  if (tbody) {
    const template = document.querySelector('#group')
    const row = tbody.insertRow()
    const clone = document.importNode(template.content, true)
    const commit = clone.querySelector('td span.commit')
    const rollback = clone.querySelector('td span.rollback')

    row.id = uuid
    row.classList.add('group')
    row.classList.add('new')
    row.dataset.oid = oid
    row.dataset.status = 'unknown'

    commit.id = uuid + '_commit'
    commit.dataset.record = uuid

    rollback.id = uuid + '_rollback'
    rollback.dataset.record = uuid

    const fields = [
      { suffix: 'name', oid: `${oid}.1`, selector: 'td input.name' },
      { suffix: 'firstcard', oid: `${oid}.3`, selector: 'td input.firstcard' },
    ]

    fields.forEach((f) => {
      const field = clone.querySelector(f.selector)
      if (field) {
        field.id = uuid + '-' + f.suffix
        field.value = ''
        field.dataset.oid = f.oid
        field.dataset.record = uuid
        field.dataset.original = ''
        field.dataset.value = ''

        // ... sigh .. Safari is awful
        if (`${navigator.vendor}`.toLowerCase().includes('apple')) {
          field.classList.add('apple')
        }
      } else {
        console.error(f)
      }
    })

    row.appendChild(clone)

    return row
  }
}

function updateFromDB(oid, record) {
  const row = document.querySelector("div#groups tr[data-oid='" + oid + "']")

  const name = row.querySelector(`[data-oid="${oid}${schema.groups.name}"]`)
  const firstcard = row.querySelector(`[data-oid="${oid}${schema.groups.firstcard}"]`)
  const doors = [...DB.doors.values()].filter((o) => o.status && o.status !== '<new>' && alive(o))

  row.dataset.status = record.status

  update(name, record.name)
  update(firstcard, record.firstcard)

  doors.forEach((o) => {
    const td = row.querySelector(`td[data-door="${o.OID}"]`)

    if (td) {
      const e = td.querySelector('.field')
      const d = record.doors.get(`${e.dataset.oid}`)

      update(e, d && d.allowed)
    }
  })

  return row
}
