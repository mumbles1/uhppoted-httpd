import { update, trim } from './tabular.js'
import { DB, alive } from './db.js'
import { Combobox } from './combobox.js'
import { loaded } from './uhppoted.js'

export function refreshed() {
  const doors = [...DB.doors.values()].filter((d) => alive(d)).sort((p, q) => p.created.localeCompare(q.created))

  realize(doors)

  doors.forEach((d) => {
    const row = updateFromDB(d.OID, d)
    if (row) {
      if (d.status === 'new') {
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

function realize(doors) {
  const table = document.querySelector('#doors table')
  const tbody = table.tBodies[0]

  // ... rows
  trim('doors', doors, tbody.querySelectorAll('tr.door'))

  doors.forEach((o) => {
    let row = tbody.querySelector("tr[data-oid='" + o.OID + "']")

    if (!row) {
      row = add(o.OID, o)
    }
  })
}

function add(oid) {
  const uuid = 'R' + oid.replaceAll(/[^0-9]/g, '')
  const tbody = document.getElementById('doors').querySelector('table tbody')

  if (tbody) {
    const template = document.querySelector('#door')
    const row = tbody.insertRow()
    const clone = document.importNode(template.content, true)
    const commit = clone.querySelector('td span.commit')
    const rollback = clone.querySelector('td span.rollback')
    const popover = clone.querySelector(`td.firstcard div[popover]`)
    const button = clone.querySelector(`td.firstcard button`)

    row.id = uuid
    row.classList.add('door')
    row.classList.add('new')
    row.dataset.oid = oid
    row.dataset.status = 'unknown'

    commit.id = uuid + '_commit'
    commit.dataset.record = uuid

    rollback.id = uuid + '_rollback'
    rollback.dataset.record = uuid

    // {{if .WithFirstCard}}
    popover.id = `${uuid}_popover`
    button.popoverTargetElement = popover
    // {{end}}

    const fields = [
      { suffix: 'name', oid: `${oid}.1`, selector: 'td input.name' },
      {
        suffix: 'controller',
        oid: `${oid}.0.4.2`,
        selector: 'td input.controller',
      },
      {
        suffix: 'deviceID',
        oid: `${oid}.0.4.3`,
        selector: 'td input.deviceID',
      },
      { suffix: 'doorID', oid: `${oid}.0.4.4`, selector: 'td input.doorID' },
      { suffix: 'delay', oid: `${oid}.2`, selector: 'td input.delay' },
      { suffix: 'mode', oid: `${oid}.3`, selector: 'td input.mode' },
      { suffix: 'keypad', oid: `${oid}.4`, selector: 'td label.keypad input' },
      { suffix: 'passcodes', oid: `${oid}.5`, selector: 'td input.passcodes' },

      // {{if .WithFirstCard}}
      { suffix: 'firstcard.start-time', oid: `${oid}.6.1`, selector: 'td input.firstcard-starttime' },
      { suffix: 'firstcard.end-time', oid: `${oid}.6.2`, selector: 'td input.firstcard-endtime' },
      { suffix: 'firstcard.active-mode', oid: `${oid}.6.3`, selector: 'td select.firstcard-active' },
      { suffix: 'firstcard.inactive-mode', oid: `${oid}.6.4`, selector: 'td select.firstcard-inactive' },
      { suffix: 'firstcard.monday', oid: `${oid}.6.5.1`, selector: 'td input.firstcard-monday' },
      { suffix: 'firstcard.tuesday', oid: `${oid}.6.5.2`, selector: 'td input.firstcard-tuesday' },
      { suffix: 'firstcard.wednesday', oid: `${oid}.6.5.3`, selector: 'td input.firstcard-wednesday' },
      { suffix: 'firstcard.thursday', oid: `${oid}.6.5.4`, selector: 'td input.firstcard-thursday' },
      { suffix: 'firstcard.friday', oid: `${oid}.6.5.5`, selector: 'td input.firstcard-friday' },
      { suffix: 'firstcard.saturday', oid: `${oid}.6.5.6`, selector: 'td input.firstcard-saturday' },
      { suffix: 'firstcard.sunday', oid: `${oid}.6.5.7`, selector: 'td input.firstcard-sunday' },
      // {{ end }}
    ]

    // {{if .WithFirstCard}}
    const labels = {
      monday: clone.querySelector('input.field.firstcard-monday ~ label'),
      tuesday: clone.querySelector('input.field.firstcard-tuesday ~ label'),
      wednesday: clone.querySelector('input.field.firstcard-wednesday ~ label'),
      thursday: clone.querySelector('input.field.firstcard-thursday ~ label'),
      friday: clone.querySelector('input.field.firstcard-friday ~ label'),
      saturday: clone.querySelector('input.field.firstcard-saturday ~ label'),
      sunday: clone.querySelector('input.field.firstcard-sunday ~ label'),
    }
    // {{ end }}

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

    // ... checkboxes
    // {{if .WithFirstCard}}
    labels.monday.htmlFor = uuid + '-firstcard.monday'
    labels.tuesday.htmlFor = uuid + '-firstcard.tuesday'
    labels.wednesday.htmlFor = uuid + '-firstcard.wednesday'
    labels.thursday.htmlFor = uuid + '-firstcard.thursday'
    labels.friday.htmlFor = uuid + '-firstcard.friday'
    labels.saturday.htmlFor = uuid + '-firstcard.saturday'
    labels.sunday.htmlFor = uuid + '-firstcard.sunday'
    // {{ end }}

    combobox(clone.querySelector('td.combobox'))

    row.appendChild(clone)

    return row
  }
}

function updateFromDB(oid, record) {
  const row = document.querySelector("div#doors tr[data-oid='" + oid + "']")

  const name = row.querySelector(`[data-oid="${oid}.1"]`)
  const controller = row.querySelector(`[data-oid="${oid}.0.4.2"]`)
  const deviceID = row.querySelector(`[data-oid="${oid}.0.4.3"]`)
  const door = row.querySelector(`[data-oid="${oid}.0.4.4"]`)
  const delay = row.querySelector(`[data-oid="${oid}.2"]`)
  const mode = row.querySelector(`[data-oid="${oid}.3"]`)
  const keypad = row.querySelector(`[data-oid="${oid}.4"]`)
  const passcodes = row.querySelector(`[data-oid="${oid}.5"]`)

  // {{if .WithFirstCard}}
  const firstcard = {
    start: row.querySelector(`[data-oid="${oid}.6.1"]`),
    end: row.querySelector(`[data-oid="${oid}.6.2"]`),
    active: row.querySelector(`[data-oid="${oid}.6.3"]`),
    inactive: row.querySelector(`[data-oid="${oid}.6.4"]`),
    monday: row.querySelector(`[data-oid="${oid}.6.5.1"]`),
    tuesday: row.querySelector(`[data-oid="${oid}.6.5.2"]`),
    wednesday: row.querySelector(`[data-oid="${oid}.6.5.3"]`),
    thursday: row.querySelector(`[data-oid="${oid}.6.5.4"]`),
    friday: row.querySelector(`[data-oid="${oid}.6.5.5"]`),
    saturday: row.querySelector(`[data-oid="${oid}.6.5.6"]`),
    sunday: row.querySelector(`[data-oid="${oid}.6.5.7"]`),
  }
  // {{ end }}

  row.dataset.status = record.status

  const d = record.delay.status === 'uncertain' ? record.delay.configured : record.delay.delay
  const m = record.mode.status === 'uncertain' ? record.mode.configured : record.mode.mode
  const c = lookup(record)

  update(name, record.name)
  update(controller, c.name)
  update(deviceID, c.deviceID)
  update(door, c.door)
  update(delay, d, record.delay.status)
  update(mode, m, record.mode.status)
  update(keypad, record.keypad)
  update(passcodes, record.passcodes)

  // {{if .WithFirstCard}}
  update(firstcard.start, record.firstcard.startTime)
  update(firstcard.end, record.firstcard.endTime)
  update(firstcard.active, record.firstcard.activeMode)
  update(firstcard.inactive, record.firstcard.inactiveMode)
  update(firstcard.monday, record.firstcard.weekdays.monday)
  update(firstcard.tuesday, record.firstcard.weekdays.tuesday)
  update(firstcard.wednesday, record.firstcard.weekdays.wednesday)
  update(firstcard.thursday, record.firstcard.weekdays.thursday)
  update(firstcard.friday, record.firstcard.weekdays.friday)
  update(firstcard.saturday, record.firstcard.weekdays.saturday)
  update(firstcard.sunday, record.firstcard.weekdays.sunday)
  // {{ end }}

  // ... set tooltips for error'd values
  {
    const tooltip = row.querySelector(`[data-oid="${oid}.2"] + div.tooltip-content`)

    if (tooltip) {
      const p = tooltip.querySelector('p')
      const err = record.delay.err && record.delay.err !== '' ? record.delay.err : ''
      const enabled = !!(record.delay.err && record.delay.err !== '')

      p.innerHTML = err

      if (enabled) {
        tooltip.classList.add('enabled')
      } else {
        tooltip.classList.remove('enabled')
      }
    }
  }

  {
    const tooltip = row.querySelector(`[data-oid="${oid}.3"] + ul + div`)

    if (tooltip) {
      const p = tooltip.querySelector('p')
      const err = record.mode.err && record.mode.err !== '' ? record.mode.err : ''
      const enabled = !!(record.mode.err && record.mode.err !== '')

      p.innerHTML = err

      if (enabled) {
        tooltip.classList.add('enabled')
      } else {
        tooltip.classList.remove('enabled')
      }
    }
  }

  return row
}

function lookup(record) {
  const oid = record.OID

  const object = {
    name: '',
    deviceID: '',
    door: '',
  }

  const controller = [...DB.controllers.values()].find((c) => {
    for (const d of [1, 2, 3, 4]) {
      if (c.doors[d] === oid) {
        return true
      }
    }

    return false
  })

  if (controller) {
    object.name = controller.name
    object.deviceID = controller.deviceID

    for (const d of [1, 2, 3, 4]) {
      if (controller.doors[d] === oid) {
        object.door = d
      }
    }
  }

  return object
}

function combobox(div) {
  const input = div.querySelector('input')
  const list = div.querySelector('ul')
  const options = new Set(['controlled', 'normally open', 'normally closed'])
  const cb = new Combobox(input, list)

  cb.initialise(options)

  return cb
}
