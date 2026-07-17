// ===== CONFIGURATION =====
const ROOMS = [
  { id: 'brihaspati',  name: 'Brihaspati',               floor: '2nd Floor', color: '#7B6FDF', colorLight: '#FAFAFE' },
  { id: 'vedvyas',     name: 'Vedvyas',                   floor: '2nd Floor', color: '#2E9E6B', colorLight: '#F8FDFB' },
  { id: 'conf2f',      name: '2nd Floor Conference Room', floor: '2nd Floor', color: '#3A8FC7', colorLight: '#F8FBFE' },
  { id: 'parashurama', name: 'Parashurama',               floor: '4th Floor', color: '#D4631A', colorLight: '#FEFAF7' },
  { id: 'pingala',     name: 'Pingala',                   floor: '4th Floor', color: '#B8860B', colorLight: '#FEFDF7' },
  { id: 'chanakya',    name: 'Chanakya',                  floor: '4th Floor', color: '#8E44AD', colorLight: '#FDF9FF' },
  { id: 'bhardwaja',   name: 'Bhardwaja',                 floor: '4th Floor', color: '#1A9B94', colorLight: '#F7FEFE' },
  { id: 'vishwamitra', name: 'Vishwamitra',               floor: '2nd Floor', color: '#C0395A', colorLight: '#FFF8FA' },
  { id: 'vasistha',    name: 'Vasistha',                  floor: '2nd Floor', color: '#2471A3', colorLight: '#F7FBFE' },
  { id: 'sharada',     name: 'Sharada',                   floor: '2nd Floor', color: '#5D8A27', colorLight: '#F8FCF4' },
];

// ===== STATE =====
let bookings = [];
let adminLoggedIn = false;
let _sessionToken = null; // issued by server on login, required for all admin writes
let deleteTargetId = null;
let clockInterval = null;
let timelineDay = 'today';

// Login rate limiting
let _loginAttempts = 0;
let _loginLockedUntil = 0;
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000; // 5 minutes

// Session timeout — 30 min inactivity
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const SESSION_WARNING_MS = 5 * 60 * 1000; // warn 5 min before actual timeout
let _lastActivityAt = Date.now();
let _sessionWarningShown = false;
function _touchActivity() {
  _lastActivityAt = Date.now();
  _sessionWarningShown = false; // any activity resets the warning too, not just the timer
}
document.addEventListener('click', _touchActivity);
document.addEventListener('keydown', _touchActivity);
setInterval(() => {
  if (!adminLoggedIn) return;
  const idleFor = Date.now() - _lastActivityAt;
  if (idleFor > SESSION_TIMEOUT_MS) {
    adminLoggedIn = false;
    _sessionToken = null;
    _sessionWarningShown = false;
    document.getElementById('logout-btn').style.display = 'none';
    showPage('status');
    toast('Session expired. Please log in again.');
  } else if (idleFor > SESSION_TIMEOUT_MS - SESSION_WARNING_MS && !_sessionWarningShown) {
    _sessionWarningShown = true;
    toast('Your session will expire in 5 minutes due to inactivity — click anywhere to stay logged in.', false, 7000);
  }
}, 60000); // check every minute
let _tablePage = 0;
let _tablePageLocked = false;
let _sortField = 'datetime'; // 'datetime' | 'room' | 'booker' | 'status'
let _sortDir = 'desc'; // 'asc' | 'desc'
const PAGE_SIZE = 15; // bookings per page in admin table

// ===== STORAGE (Supabase) =====
const SUPABASE_URL = 'https://xgrwmwibfkuxzkuuidsh.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable__-SxyNxa9RJAZyW81_a27A_O_kv5Gl-';
// TODO: set this to the email you used in Supabase → Authentication → Users → Add user
const ADMIN_EMAIL = 'shaunakmistry4@gmail.com';

supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

let _writeCompletedAt = 0;

// Prevent loadData from wiping local optimistic updates right after a write.
// Postgres commits are immediate, but a silent poll landing mid-render can
// still feel like a flicker, so we keep the same short debounce as before.
function _writeRecentlyCompleted() {
  return (Date.now() - _writeCompletedAt) < 3000;
}

async function loadData(silent = false) {
  if (silent && _writeRecentlyCompleted()) return;
  try {
    if (!silent) showLoadingOverlay(true);
    const { data, error } = await supabase.from('bookings').select('*');
    if (error) throw error;
    bookings = (data || []).map(r => ({
      id: String(r.booking_id || '').trim(),
      room: String(r.room || '').trim(),
      booker: String(r.booked_by || '').trim(),
      purpose: String(r.purpose || '').trim(),
      date: String(r.booking_date || '').trim(),               // Postgres date -> 'YYYY-MM-DD'
      start: String(r.start_time || '00:00:00').trim().substring(0,5),  // 'HH:MM:SS' -> 'HH:MM'
      end: String(r.end_time || '00:00:00').trim().substring(0,5),
      attendees: r.attendees != null ? String(r.attendees) : '',
      status: String(r.status || 'Confirmed').trim(),
      endDate: String(r.end_date || '').trim(),
      conflictResolved: !!r.conflict_resolved,
      conflictNote: String(r.conflict_note || '').trim()
    }));
    // Sort by creation time (embedded in booking_id as 'b' + base36 timestamp + random).
    bookings.sort((a, b) => {
      const ta = a.id || '';
      const tb = b.id || '';
      return tb > ta ? 1 : (tb < ta ? -1 : 0); // newest created first
    });
  } catch(e) {
    console.error('Load error', e);
    bookings = [];
    toast('Could not load bookings. Check connection.', true);
  } finally {
    if (!silent) showLoadingOverlay(false);
  }
}

async function apiCreate(b) {
  const endDate = b.endDate || (isOvernight(b) ? addDaysStr(b.date, 1) : b.date);
  const { error } = await supabase.from('bookings').insert({
    booking_id: b.id, room: b.room, booked_by: b.booker, purpose: b.purpose || '',
    booking_date: b.date, start_time: b.start, end_time: b.end,
    attendees: b.attendees || null, status: b.status || 'Confirmed', end_date: endDate
  });
  if (error) throw error;
  _writeCompletedAt = Date.now();
}

async function apiUpdateStatus(id, status) {
  const { error } = await supabase.from('bookings').update({ status }).eq('booking_id', id);
  if (error) throw error;
  _writeCompletedAt = Date.now();
}

async function apiSetConflictResolved(id, resolved, note) {
  const { error } = await supabase.from('bookings')
    .update({ conflict_resolved: !!resolved, conflict_note: note || '' })
    .eq('booking_id', id);
  if (error) throw error;
  _writeCompletedAt = Date.now();
}

// Batch variants — used for recurring bookings and bulk admin actions. A single
// insert/update call for the whole batch, same as the old combined-notification design.
async function apiCreateRequestBatch(bookingsArr) {
  const rows = bookingsArr.map(b => {
    const endDate = b.endDate || (isOvernight(b) ? addDaysStr(b.date, 1) : b.date);
    return {
      booking_id: b.id, room: b.room, booked_by: b.booker, purpose: b.purpose || '',
      booking_date: b.date, start_time: b.start, end_time: b.end,
      attendees: b.attendees || null, status: 'Pending', end_date: endDate
    };
  });
  const { error } = await supabase.from('bookings').insert(rows);
  if (error) throw error;
  _writeCompletedAt = Date.now();
}

async function apiUpdateStatusBatch(ids, status) {
  const { error } = await supabase.from('bookings').update({ status }).in('booking_id', ids);
  if (error) throw error;
  _writeCompletedAt = Date.now();
}

async function apiUpdate(b) {
  // Postgres updates are transactional and immediate, so — unlike the old
  // Apps Script version — this is a single UPDATE, no delete-then-recreate
  // dance and no artificial 1.5s wait for eventual consistency.
  const endDate = b.endDate || (isOvernight(b) ? addDaysStr(b.date, 1) : b.date);
  const { error } = await supabase.from('bookings').update({
    room: b.room, booked_by: b.booker, purpose: b.purpose || '',
    booking_date: b.date, start_time: b.start, end_time: b.end,
    attendees: b.attendees || null, status: b.status || 'Confirmed', end_date: endDate,
    conflict_resolved: !!b.conflictResolved, conflict_note: b.conflictNote || ''
  }).eq('booking_id', b.id);
  if (error) throw error;
  _writeCompletedAt = Date.now();
}

async function apiDelete(id) {
  const { error } = await supabase.from('bookings').delete().eq('booking_id', id);
  if (error) throw error;
  _writeCompletedAt = Date.now();
}

// Public self-service actions. These call SECURITY DEFINER Postgres functions
// that re-verify the name match server-side (see supabase/schema.sql) — the
// anon key alone cannot cancel/edit someone else's booking even if the
// client-side check below is bypassed.
async function apiCancelOwn(id, bookerName) {
  const { data, error } = await supabase.rpc('cancel_own_booking', {
    p_booking_id: id, p_booker_name: bookerName
  });
  if (error) throw error;
  if (!data.ok) throw new Error(data.error);
  _writeCompletedAt = Date.now();
}

async function apiReleaseOwn(id, bookerName, endTime, endDate) {
  const { data, error } = await supabase.rpc('release_own_booking', {
    p_booking_id: id, p_booker_name: bookerName, p_end_time: endTime, p_end_date: endDate
  });
  if (error) throw error;
  if (!data.ok) throw new Error(data.error);
  _writeCompletedAt = Date.now();
}

function showLoadingOverlay(show) {
  let el = document.getElementById('loading-overlay');
  if (!el) return;
  el.style.display = show ? 'flex' : 'none';
}

// ===== HELPERS =====
function genId() {
  const ts = Date.now().toString(36);
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(10)))
    .map(b => b.toString(36).padStart(2,'0')).join('').slice(0,12);
  return 'b' + ts + rand;
}

function pad(n) { return String(n).padStart(2,'0'); }

function todayStr() {
  return localDateStr(new Date());
}

function localDateStr(d) {
  // Always uses local time - never UTC - fixes GMT+5:30 timezone shift
  return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate());
}

function fmtDate(ds) {
  const [y,m,d] = ds.split('-');
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${parseInt(d)} ${names[parseInt(m)-1]} ${y}`;
}

function fmtTime(ts) {
  if (!ts) return '—';
  ts = String(ts).trim();
  if (!ts || ts === 'undefined') return '—';
  // Parse to 24hr first via parseTime, then format
  const mins = parseTimeToMins(ts);
  if (mins === null) return '—';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const ap = h >= 12 ? 'PM' : 'AM';
  const hr = h % 12 || 12;
  return `${hr}:${pad(m)} ${ap}`;
}

function parseTimeToMins(ts) {
  if (!ts) return null;
  ts = String(ts).trim();
  // "H:MM AM/PM" or "H:MM:SS AM/PM"
  const ampm = ts.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)$/i);
  if (ampm) {
    let h = parseInt(ampm[1]);
    const m = parseInt(ampm[2]);
    const period = ampm[3].toUpperCase();
    if (period === 'AM' && h === 12) h = 0;
    if (period === 'PM' && h !== 12) h += 12;
    return h * 60 + m;
  }
  // "HH:MM" or "HH:MM:SS" 24hr
  const hhmm = ts.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (hhmm) {
    return parseInt(hhmm[1]) * 60 + parseInt(hhmm[2]);
  }
  // Fraction of day (Google Sheets serial)
  const num = parseFloat(ts);
  if (!isNaN(num) && num > 0 && num < 1) {
    return Math.round(num * 24 * 60);
  }
  return null;
}

function minutesSinceMidnight(ts) {
  const mins = parseTimeToMins(ts);
  return mins !== null ? mins : 0;
}

function nowMinutes() {
  const n = new Date();
  return n.getHours() * 60 + n.getMinutes();
}

// ===== OVERNIGHT BOOKING HELPERS =====
function addDaysStr(ds, n) {
  const [y,m,d] = ds.split('-').map(Number);
  const dt = new Date(y, m-1, d);
  dt.setDate(dt.getDate() + n);
  return localDateStr(dt);
}

function isOvernight(b) {
  return minutesSinceMidnight(b.end) < minutesSinceMidnight(b.start);
}

// Splits a booking into 1 or 2 {date, start, end} minute-spans (handles midnight crossover)
function bookingSpans(b) {
  const s = minutesSinceMidnight(b.start);
  const e = minutesSinceMidnight(b.end);
  if (e > s) return [{ date: b.date, start: s, end: e }];
  const spans = [{ date: b.date, start: s, end: 1440 }];
  if (e > 0) spans.push({ date: addDaysStr(b.date, 1), start: 0, end: e });
  return spans;
}

// Finds a conflicting booking for room/date/start/end, considering overnight spans
function findConflict(room, date, start, end, excludeId) {
  return findAllConflicts(room, date, start, end, excludeId)[0] || null;
}

// Computes conflicts for an EXISTING booking, live, against current data —
// used by admin views (pending list, all-bookings table) so the warning is
// always accurate right now and disappears automatically the moment the
// conflicting booking is deleted/cancelled/rejected. Never stored, never stale.
function getLiveConflicts(b) {
  return findAllConflicts(b.room, b.date, b.start, b.end, b.id);
}

function describeConflict(c) {
  const isPending = c.status === 'Pending';
  const statusLabel = isPending ? 'a pending request' : 'a confirmed booking';
  return `${statusLabel} ${fmtTime(c.start)}–${fmtTime(c.end)} by ${c.booker} on ${fmtDate(c.date)}`;
}

function formatLiveConflictNote(conflicts) {
  if (conflicts.length === 0) return '';
  if (conflicts.length === 1) return `⚠️ Overlap: ${describeConflict(conflicts[0])}`;
  return `⚠️ ${conflicts.length} overlaps: ` + conflicts.map(describeConflict).join('; ');
}

// Strips legacy conflict notes that older versions of this app baked directly
// into the Purpose field (before conflict detection became live-computed at
// render time). Old format always ends the string with "[⚠️ Overlap: ...]" or
// "[⚠️ N overlaps: ...]". Only affects DISPLAY — never touches stored data,
// so old bookings won't show stale conflict text anywhere it's shown to a
// user, while the actual live conflict badge (computed separately) stays accurate.
function displayPurpose(purpose) {
  if (!purpose) return purpose;
  return purpose.replace(/\s*\[⚠️[^\]]*\]\s*$/, '');
}

// Marks a conflict resolved (with an admin note describing how) or undoes it.
// Saved permanently in the sheet — ConflictResolved + ConflictNote columns —
// visible to every admin on every device, and shown on the public room cards too.
let _resolveConflictBookingId = null;

async function toggleConflictResolved(bookingId) {
  const b = bookings.find(x => x.id === bookingId);
  if (!b) return;

  if (b.conflictResolved) {
    // Undo — restore the warning, clear the note. Immediate, no modal needed —
    // this is a simple reversible action, same as other Undo buttons in the app.
    const prevNote = b.conflictNote;
    b.conflictResolved = false;
    b.conflictNote = '';
    renderPendingRequests(); renderTable(); renderStatusGrid();
    try {
      await apiSetConflictResolved(bookingId, false, '');
      toast('Conflict warning restored.');
    } catch(e) {
      b.conflictResolved = true; b.conflictNote = prevNote;
      renderPendingRequests(); renderTable(); renderStatusGrid();
      toast('Could not update — check connection.', true);
    }
    return;
  }

  // Marking resolved — open the styled modal instead of a native browser prompt
  _resolveConflictBookingId = bookingId;
  const liveConflicts = getLiveConflicts(b);
  const thisOne = `${b.booker}, ${fmtTime(b.start)}–${fmtTime(b.end)} on ${fmtDate(b.date)}`;
  const otherOnes = liveConflicts.map(c => `${c.booker}, ${fmtTime(c.start)}–${fmtTime(c.end)} on ${fmtDate(c.date)} (${c.status})`).join('\n');
  document.getElementById('resolve-conflict-details').textContent = `Resolving conflict for:\n  ${thisOne}\nagainst:\n  ${otherOnes}`;
  document.getElementById('resolve-conflict-note').value = b.conflictNote || '';
  document.getElementById('resolve-conflict-modal').style.display = 'flex';
}

// Generic styled confirm modal — Promise-based so it drops in wherever native
// confirm() was used: `if (!(await showConfirmModal('...'))) return;` works
// exactly like `if (!confirm('...')) return;` did, just with the app's own
// styling instead of the browser's native dialog chrome.
let _confirmModalResolve = null;
function showConfirmModal(message, confirmLabel, confirmClass) {
  return new Promise(resolve => {
    _confirmModalResolve = resolve;
    document.getElementById('confirm-modal-message').textContent = message;
    const btn = document.getElementById('confirm-modal-confirm-btn');
    btn.textContent = confirmLabel || 'Confirm';
    btn.className = 'btn ' + (confirmClass || 'btn-approve');
    document.getElementById('confirm-modal').style.display = 'flex';
  });
}
function _resolveConfirmModal(result) {
  document.getElementById('confirm-modal').style.display = 'none';
  if (_confirmModalResolve) { _confirmModalResolve(result); _confirmModalResolve = null; }
}

function closeResolveConflictModal() {
  document.getElementById('resolve-conflict-modal').style.display = 'none';
  _resolveConflictBookingId = null;
}

async function confirmResolveConflict() {
  const bookingId = _resolveConflictBookingId;
  const b = bookings.find(x => x.id === bookingId);
  if (!b) { closeResolveConflictModal(); return; }

  const trimmedNote = document.getElementById('resolve-conflict-note').value.trim();
  closeResolveConflictModal();

  b.conflictResolved = true;
  b.conflictNote = trimmedNote;
  renderPendingRequests(); renderTable(); renderStatusGrid();
  try {
    await apiSetConflictResolved(bookingId, true, trimmedNote);
    toast('Marked as resolved.');
  } catch(e) {
    b.conflictResolved = false; b.conflictNote = '';
    renderPendingRequests(); renderTable(); renderStatusGrid();
    toast('Could not update — check connection.', true);
  }
}

// Returns EVERY overlapping booking for this room/date/time, not just the
// first one found — a single slot can have more than one conflicting request
// (e.g. two different pending requests both overlapping the same confirmed booking).
function findAllConflicts(room, date, start, end, excludeId) {
  const newSpans = bookingSpans({ date, start, end });
  const found = [];
  for (const b of bookings) {
    if (b.room !== room) continue;
    if (excludeId && b.id === excludeId) continue;
    if (b.status === 'Rejected' || b.status === 'Cancelled') continue;
    let overlaps = false;
    for (const ex of bookingSpans(b)) {
      for (const ns of newSpans) {
        if (ex.date === ns.date && ns.start < ex.end && ns.end > ex.start) { overlaps = true; break; }
      }
      if (overlaps) break;
    }
    if (overlaps) found.push(b); // each conflicting booking added once, even if it has multiple overlapping spans (e.g. overnight)
  }
  return found;
}

// 'active' | 'past' | 'upcoming' relative to now, handling overnight spans
function bookingTimeStatus(b) {
  const today = todayStr();
  const now = nowMinutes();
  const spans = bookingSpans(b);
  for (const sp of spans) {
    if (sp.date === today && now >= sp.start && now < sp.end) return 'active';
  }
  const last = spans[spans.length - 1];
  if (last.date < today || (last.date === today && last.end <= now)) return 'past';
  return 'upcoming';
}

// For the room status tile: elapsed/total minutes if this booking is active right now
function activeSpanInfo(b) {
  const today = todayStr();
  const now = nowMinutes();
  const s = minutesSinceMidnight(b.start), e = minutesSinceMidnight(b.end);
  const overnight = e <= s;
  const total = overnight ? (1440 - s + e) : (e - s);
  if (total <= 0) return null;
  if (!overnight) {
    if (b.date === today && now >= s && now < e) return { elapsed: now - s, total };
    return null;
  }
  if (b.date === today && now >= s) return { elapsed: now - s, total };
  if (addDaysStr(b.date, 1) === today && now < e) return { elapsed: (1440 - s) + now, total };
  return null;
}

function roomName(id) {
  const r = ROOMS.find(r => r.id === id);
  return r ? r.name : id;
}

// Get current/upcoming bookings for a room, handling overnight bookings
function getRoomStatus(roomId) {
  const today = todayStr();
  const now = nowMinutes();
  const relevant = bookings.filter(b => b.room === roomId && (b.status === 'Confirmed' || !b.status));

  // Find a booking that's active right now (today, or spilling over from yesterday)
  let activeBooking = null, activeInfo = null;
  for (const b of relevant) {
    const info = activeSpanInfo(b);
    if (info) { activeBooking = b; activeInfo = info; break; }
  }

  // Helper: bookings with a span starting later today (after now)
  const upcomingToday = relevant
    .filter(b => b !== activeBooking)
    .map(b => {
      const sp = bookingSpans(b).find(s => s.date === today && s.start > now);
      return sp ? { b, start: sp.start } : null;
    })
    .filter(Boolean)
    .sort((a, c) => a.start - c.start)
    .map(x => x.b);

  if (activeBooking) {
    const remaining = activeInfo.total - activeInfo.elapsed;
    const pct = Math.min(100, Math.round((activeInfo.elapsed / activeInfo.total) * 100));
    return {
      status: remaining <= 30 ? 'soon' : 'occupied',
      booking: activeBooking,
      remaining,
      pct,
      nextBookings: upcomingToday
    };
  }

  return {
    status: 'free',
    booking: null,
    remaining: null,
    pct: 0,
    nextBookings: upcomingToday.slice(0, 1)
  };
}

// ===== ROOM STATUS GRID =====
function renderStatusGrid() {
  const grid = document.getElementById('rooms-grid');
  const today = new Date();
  document.getElementById('status-date').textContent =
    today.toLocaleDateString('en-IN', { weekday:'long', year:'numeric', month:'long', day:'numeric' });

  let freeCount = 0, occCount = 0, soonCount = 0;
  let html = '';
  const floorFilter = document.getElementById('floor-filter')?.value || '';

  for (const room of ROOMS) {
    if (floorFilter && room.floor !== floorFilter) continue;
    const { status, booking, remaining, pct, nextBookings } = getRoomStatus(room.id);
    if (status === 'free') freeCount++;
    else if (status === 'occupied') occCount++;
    else soonCount++;

    let badgeClass, badgeText, cardClass, barClass;
    if (status === 'free') {
      badgeClass = 'badge-free'; badgeText = 'Available'; cardClass = 'free'; barClass = 'free';
    } else if (status === 'soon') {
      badgeClass = 'badge-soon'; badgeText = 'Ending Soon'; cardClass = 'ending-soon'; barClass = 'warn';
    } else {
      badgeClass = 'badge-occupied'; badgeText = 'In Use'; cardClass = 'occupied'; barClass = '';
    }

    const roomColor = room.color || '#5B4FCF';
    const roomLight = room.colorLight || '#EDE8FF';
    const roomBorder = roomColor + '18';
    const roomShadow = roomColor + '18';

    let bodyHtml = '';
    if (booking) {
      const mins = remaining;
      const freeAt = fmtTime(booking.end);
      bodyHtml += `
        <div class="room-info-row">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          <span class="room-booker">${escHtml(booking.booker)}</span>
        </div>`;
      if (booking.purpose) {
        bodyHtml += `<div class="room-info-row">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          <span>${escHtml(displayPurpose(booking.purpose))}</span>
        </div>`;
      }
      if (booking.conflictResolved && booking.conflictNote) {
        bodyHtml += `<div class="room-info-row" style="color:var(--text-muted);font-size:12px;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
          <span>${escHtml(booking.conflictNote)}</span>
        </div>`;
      }
      bodyHtml += `<div class="room-info-row">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          <span>Free at <strong>${freeAt}</strong> &mdash; ${mins} min remaining</span>
        </div>`;
      bodyHtml += `<div class="room-time-bar"><div class="room-time-fill ${barClass}" style="width:${pct}%"></div></div>`;
      bodyHtml += `<div class="room-time-label">${fmtTime(booking.start)} – ${fmtTime(booking.end)}</div>`;
      bodyHtml += `<button class="btn-release-early" onclick="openReleaseModal('${booking.id}')">Release Room Now</button>`;
    } else {
      const nextToday = nextBookings[0];
      const freeUntilText = nextToday ? `Free until ${fmtTime(nextToday.start)}` : 'Free all day';
      bodyHtml += `<div class="room-info-row" style="color:var(--text);font-weight:500;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
        <span>${freeUntilText}</span>
      </div>`;
      bodyHtml += `<div class="room-time-bar"><div class="room-time-fill free" style="width:0%"></div></div>`;
      bodyHtml += `<div class="room-time-label">&nbsp;</div>`;
    }

    if (nextBookings.length > 0) {
      const nb = nextBookings[0];
      bodyHtml += `<div class="next-booking-note">
        Next: <strong>${escHtml(nb.booker)}</strong> at ${fmtTime(nb.start)}
        ${nb.purpose ? '&mdash; ' + escHtml(displayPurpose(nb.purpose)) : ''}
      </div>`;
    }

    const pendingForRoom = bookings.filter(b => b.room === room.id && b.status === 'Pending').length;
    const pendingTag = pendingForRoom > 0 ? `<span style="font-size:11px;background:var(--warn-light);color:var(--warn);padding:2px 7px;border-radius:999px;font-weight:600;margin-left:6px;">${pendingForRoom} pending</span>` : '';

    html += `<div class="room-card ${cardClass}" style="--room-color:${roomColor};--room-bg:${roomLight};--room-border:${roomBorder};--room-shadow:${roomShadow};">
      <div class="room-card-top" onclick="openSchedModal('${room.id}')" title="Click to view 30-day schedule" style="cursor:pointer">
        <div>
          <div class="room-name">${escHtml(room.name)}${pendingTag}</div>
          <div class="room-floor">${escHtml(room.floor)}</div>
        </div>
        <span class="status-badge ${badgeClass}">${badgeText}</span>
      </div>
      ${bodyHtml}
      <button class="btn-request" onclick="openRequestModal('${room.id}')">+ Request a Booking</button>
    </div>`;
  }

  grid.innerHTML = html;
  document.getElementById('count-free').textContent = freeCount + ' available';
  document.getElementById('count-occ').textContent = occCount + ' occupied';
  document.getElementById('count-soon').textContent = soonCount + ' ending soon';
  // Update nav occupancy counter
  const total = ROOMS.length;
  const occEl = document.getElementById('occupancy-counter');
  if (occEl) {
    const occupiedCount = occCount + soonCount;
    occEl.textContent = freeCount + '/' + total + ' Available';
    occEl.style.color = freeCount > total/2 ? 'var(--ok)' : freeCount > 0 ? 'var(--warn)' : 'var(--danger)';
  }
  // Only re-render timeline if it's expanded
  const tlWrap = document.getElementById('timeline-wrap');
  if (tlWrap && tlWrap.style.display !== 'none') renderTimeline();
}

// ===== ADMIN TABLE =====
function renderTable() {
  if (!_tablePageLocked) _tablePage = 0;
  const tbody = document.getElementById('table-body');
  const search = document.getElementById('search-input').value.toLowerCase().trim();
  const filterRoom = document.getElementById('filter-room').value;
  const filterDate = document.getElementById('filter-date').value;
  const conflictsOnly = document.getElementById('filter-conflicts-only')?.checked;
  const today = todayStr();
  // Preserve current selection across re-render
  const prevSelected = new Set(getSelectedIds());

  let filtered = [...bookings];
  if (conflictsOnly) filtered = filtered.filter(b => (b.status === 'Pending' || b.status === 'Confirmed') && getLiveConflicts(b).length > 0);
  if (search) {
    filtered = filtered.filter(b =>
      b.booker.toLowerCase().includes(search) ||
      b.room.toLowerCase().includes(search) ||
      roomName(b.room).toLowerCase().includes(search) ||
      (b.purpose || '').toLowerCase().includes(search)
    );
  }
  if (filterRoom) filtered = filtered.filter(b => b.room === filterRoom);
  if (filterDate === 'today') filtered = filtered.filter(b => b.date === today);
  else if (filterDate === 'upcoming') filtered = filtered.filter(b => bookingTimeStatus(b) !== 'past');
  else if (filterDate === 'past') filtered = filtered.filter(b => bookingTimeStatus(b) === 'past');

  // Sort
  filtered.sort((a, b) => {
    let va, vb;
    if (_sortField === 'room') {
      va = roomName(a.room).toLowerCase();
      vb = roomName(b.room).toLowerCase();
    } else if (_sortField === 'status') {
      va = (a.status || '').toLowerCase();
      vb = (b.status || '').toLowerCase();
    } else {
      // Creation time, encoded in BookingID as 'b' + base36 timestamp + random suffix.
      // IMPORTANT: compare the ID as a STRING, not parseInt(id) — the timestamp
      // portion contains letters (base36), so parseInt with no radix defaults to
      // base 10 and fails immediately on the first letter, returning NaN -> 0 for
      // every single row. That made this sort a complete no-op previously (every
      // row got the same sort key of 0). String comparison works correctly here
      // because every ID has the same fixed-width structure, so lexicographic
      // ordering exactly matches chronological order — no parsing needed at all.
      va = a.id || '';
      vb = b.id || '';
    }
    if (va < vb) return _sortDir === 'asc' ? -1 : 1;
    if (va > vb) return _sortDir === 'asc' ? 1 : -1;
    return 0;
  });



  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9"><div class="empty-state">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
      <div>No bookings found.</div>
    </div></td></tr>`;
    document.getElementById('table-count').textContent = '';
    document.getElementById('pagination-controls').innerHTML = '';
    clearBulkSelection();
    return;
  }

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  if (_tablePage >= totalPages) _tablePage = totalPages - 1;
  if (_tablePage < 0) _tablePage = 0;
  const pageItems = filtered.slice(_tablePage * PAGE_SIZE, (_tablePage + 1) * PAGE_SIZE);

  let html = '';
  for (const b of pageItems) {
    let statusBadge;
    if (b.status === 'Pending') {
      statusBadge = `<span class="status-badge" style="background:var(--warn-light);color:var(--warn)">Pending</span>`;
    } else if (b.status === 'Rejected') {
      statusBadge = `<span class="status-badge" style="background:var(--danger-light);color:var(--danger)">Rejected</span>`;
    } else {
      const ts = bookingTimeStatus(b);
      if (ts === 'past') statusBadge = `<span class="status-badge" style="background:#F0EDE6;color:var(--text-muted)">Past</span>`;
      else if (ts === 'active') statusBadge = `<span class="status-badge badge-occupied">Active</span>`;
      else statusBadge = `<span class="status-badge badge-free">Upcoming</span>`;
    }
    const overnightTag = isOvernight(b) ? ' <span style="font-size:10px;color:var(--text-faint);font-weight:600">+1 day</span>' : '';
    const liveConflicts = (b.status === 'Pending' || b.status === 'Confirmed') ? getLiveConflicts(b) : [];
    let conflictNote = '';
    if (liveConflicts.length > 0 && b.conflictResolved) {
      conflictNote = `<div style="color:var(--text-muted);font-size:11px;margin-top:3px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
        ✓ Resolved${b.conflictNote ? ': ' + escHtml(b.conflictNote) : ''}
        <button class="btn btn-ghost btn-sm" style="padding:1px 6px;font-size:10px;" onclick="toggleConflictResolved('${b.id}')">Undo</button>
      </div>`;
    } else if (liveConflicts.length > 0) {
      conflictNote = `<div style="color:var(--danger);font-size:11px;font-weight:500;margin-top:3px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
        <span>${escHtml(formatLiveConflictNote(liveConflicts))}</span>
        <button class="btn btn-ghost btn-sm" style="padding:1px 6px;font-size:10px;flex-shrink:0;" onclick="toggleConflictResolved('${b.id}')">Mark Resolved</button>
      </div>`;
    }
    html += `<tr>
      <td class="cb-cell"><input type="checkbox" class="booking-cb row-cb" data-id="${b.id}" onchange="onRowCbChange()" title="Select"></td>
      <td class="td-room">${escHtml(roomName(b.room))}</td>
      <td>${escHtml(b.booker)}</td>
      <td style="color:var(--text-muted)">${escHtml(displayPurpose(b.purpose) || '—')}${conflictNote}</td>
      <td>${fmtDate(b.date)}</td>
      <td style="white-space:nowrap">${fmtTime(b.start)} – ${fmtTime(b.end)}${overnightTag}</td>
      <td>${b.attendees || '—'}</td>
      <td>${statusBadge}</td>
      <td>
        <div class="td-actions">
          <button class="btn btn-ghost btn-sm" onclick="editBooking('${b.id}')">Edit</button>
          <button class="btn btn-danger btn-sm" onclick="deleteBooking('${b.id}')">Delete</button>
        </div>
      </td>
    </tr>`;
  }
  tbody.innerHTML = html;

  // Restore checkbox selections
  document.querySelectorAll('.row-cb').forEach(cb => {
    if (prevSelected.has(cb.dataset.id)) cb.checked = true;
  });
  updateBulkBar();

  // Count label
  const start = _tablePage * PAGE_SIZE + 1;
  const end = Math.min(start + PAGE_SIZE - 1, filtered.length);
  document.getElementById('table-count').textContent = `Showing ${start}–${end} of ${filtered.length} bookings`;

  // Pagination controls
  const pc = document.getElementById('pagination-controls');
  if (totalPages <= 1) { pc.innerHTML = ''; return; }
  let pages = '';
  // Prev
  pages += `<button class="pg-btn" onclick="goToPage(${_tablePage - 1})" ${_tablePage === 0 ? 'disabled' : ''}>‹</button>`;
  // Page numbers — show at most 5 around current
  const range = [];
  for (let i = 0; i < totalPages; i++) {
    if (i === 0 || i === totalPages - 1 || (i >= _tablePage - 1 && i <= _tablePage + 1)) range.push(i);
    else if (range[range.length - 1] !== '…') range.push('…');
  }
  for (const r of range) {
    if (r === '…') pages += `<span style="padding:0 4px;color:var(--text-muted);font-size:13px;">…</span>`;
    else pages += `<button class="pg-btn ${r === _tablePage ? 'pg-active' : ''}" onclick="goToPage(${r})">${r + 1}</button>`;
  }
  // Next
  pages += `<button class="pg-btn" onclick="goToPage(${_tablePage + 1})" ${_tablePage === totalPages - 1 ? 'disabled' : ''}>›</button>`;
  pc.innerHTML = pages;
}

function goToPage(page) {
  _tablePage = page;
  _tablePageLocked = true;
  renderTable();
  _tablePageLocked = false;
}

function renderActiveNow() {
  const active = bookings.filter(b => bookingTimeStatus(b) === 'active');
  const el = document.getElementById('active-now-list');
  if (active.length === 0) {
    el.innerHTML = `<div style="font-size:13px;color:var(--text-faint);padding:8px 0;">No active bookings right now.</div>`;
    return;
  }
  el.innerHTML = active.map(b => `
    <div class="booking-list-item active-now">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
        <div style="flex:1;cursor:pointer;" onclick="editBooking('${b.id}')">
          <div class="bli-room">${escHtml(roomName(b.room))}</div>
          <div class="bli-meta">${escHtml(b.booker)} · until ${fmtTime(b.end)}</div>
        </div>
        <button class="btn btn-ghost btn-sm" style="flex-shrink:0;" onclick="event.stopPropagation();adminReleaseEarly('${b.id}')">Release Now</button>
      </div>
    </div>
  `).join('');
}

// Admin quick-action — no name verification needed (admin already authenticated).
async function adminReleaseEarly(bookingId) {
  const b = bookings.find(x => x.id === bookingId);
  if (!b) return;
  if (!(await showConfirmModal(`Release ${roomName(b.room)} now? Booked by ${b.booker}, scheduled until ${fmtTime(b.end)}.`, 'Release Now', 'btn-approve'))) return;
  if (bookingTimeStatus(b) !== 'active') {
    toast('This booking is no longer active.', true);
    return;
  }
  try {
    showLoadingOverlay(true);
    const now = new Date();
    const nowHHMM = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
    b.end = nowHHMM;
    b.endDate = todayStr();
    await apiUpdate(b);
    toast('Room released — now available.');
    renderStatusGrid(); renderActiveNow(); renderTable();
  } catch(e) {
    toast('Error — please try again.', true);
  } finally {
    showLoadingOverlay(false);
  }
}

// ===== FORM =====
function populateRoomSelects() {
  const roomSelect = document.getElementById('f-room');
  const filterSelect = document.getElementById('filter-room');
  roomSelect.innerHTML = '<option value="">Select a room...</option>';
  filterSelect.innerHTML = '<option value="">All rooms</option>';
  for (const r of ROOMS) {
    roomSelect.innerHTML += `<option value="${r.id}">${r.name} (${r.floor})</option>`;
    filterSelect.innerHTML += `<option value="${r.id}">${r.name}</option>`;
  }
}

function resetForm() {
  document.getElementById('booking-form').reset();
  document.getElementById('edit-id').value = '';
  document.getElementById('form-title').textContent = 'New Booking';
  document.getElementById('form-submit-btn').textContent = 'Book Room';
  document.getElementById('form-error').classList.remove('visible');
  document.getElementById('f-date').value = todayStr();
  document.getElementById('f-recurring').checked = false;
  document.getElementById('recurring-end-wrap').style.display = 'none';
  document.getElementById('f-end-date-wrap').style.display = 'none';
  document.getElementById('f-end-date').value = '';
  document.getElementById('f-attendees-wrap').style.display = '';
  const dateLabelEl = document.querySelector('label[for="f-date"]') || document.getElementById('f-date').previousElementSibling;
  if (dateLabelEl) dateLabelEl.textContent = 'Start Date';
  if (document.getElementById('edit-id').dataset) delete document.getElementById('edit-id').dataset.fromRequest;
}

function editBooking(id) {
  const b = bookings.find(x => x.id === id);
  if (!b) return;
  document.getElementById('edit-id').value = b.id;
  document.getElementById('f-room').value = b.room;
  document.getElementById('f-booker').value = b.booker;
  document.getElementById('f-purpose').value = displayPurpose(b.purpose) || '';
  document.getElementById('f-date').value = b.date;
  document.getElementById('f-start').value = b.start;
  document.getElementById('f-end').value = b.end;
  document.getElementById('f-attendees').value = b.attendees || '';

  // Show end date field for overnight bookings (end time < start time = crosses midnight)
  const isOvernightEdit = minutesSinceMidnight(b.end) < minutesSinceMidnight(b.start);
  const endDateWrap = document.getElementById('f-end-date-wrap');
  const attendeesWrap = document.getElementById('f-attendees-wrap');
  endDateWrap.style.display = isOvernightEdit ? '' : 'none';
  attendeesWrap.style.display = '';
  if (isOvernightEdit) {
    document.getElementById('f-end-date').value = b.endDate || addDaysStr(b.date, 1);
  } else {
    document.getElementById('f-end-date').value = '';
  }
  document.getElementById('form-title').textContent = 'Edit Booking';
  document.getElementById('form-submit-btn').textContent = 'Save Changes';
  document.getElementById('form-error').classList.remove('visible');
  // Allow recurring when editing — admin can expand to a date range
  document.getElementById('f-recurring').checked = false;
  document.getElementById('recurring-end-wrap').style.display = 'none';
  document.querySelector('.admin-sidebar').scrollTop = 0;
}

function showError(msg) {
  const el = document.getElementById('form-error');
  el.textContent = msg;
  el.classList.add('visible');
}

function toggleReqRecurring() {
  const isRecurring = document.getElementById('req-recurring').checked;
  document.getElementById('req-recurring-end-wrap').style.display = isRecurring ? 'block' : 'none';
  if (isRecurring) {
    const startDate = document.getElementById('req-date').value;
    if (startDate) document.getElementById('req-date-end').value = startDate;
  }
}

function toggleRecurring() {
  const isRecurring = document.getElementById('f-recurring').checked;
  document.getElementById('recurring-end-wrap').style.display = isRecurring ? 'block' : 'none';
  if (isRecurring) {
    const startDate = document.getElementById('f-date').value;
    if (startDate) document.getElementById('f-date-end').value = startDate;
  }
}

function getWeekdays(startStr, endStr) {
  const dates = [];
  const start = new Date(startStr + 'T00:00:00');
  const end = new Date(endStr + 'T00:00:00');
  if (end < start) return dates;
  const cur = new Date(start);
  while (cur <= end) {
    const day = cur.getDay();
    if (day !== 0 && day !== 6) {
      dates.push(localDateStr(cur));
    }
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

async function submitBooking(e) {
  e.preventDefault();
  const id = document.getElementById('edit-id').value;
  const room = document.getElementById('f-room').value;
  const booker = document.getElementById('f-booker').value.trim();
  const purpose = document.getElementById('f-purpose').value.trim();
  const date = document.getElementById('f-date').value;
  const start = document.getElementById('f-start').value;
  const end = document.getElementById('f-end').value;
  const attendees = document.getElementById('f-attendees').value;
  const isRecurring = document.getElementById('f-recurring').checked;
  const dateEnd = document.getElementById('f-date-end').value;
  const endDateOverride = document.getElementById('f-end-date').value; // overnight end date from edit form

  if (!room || !booker || !purpose || !date || !start || !end || !attendees) {
    showError('Please fill in all required fields.'); return;
  }
  if (minutesSinceMidnight(end) === minutesSinceMidnight(start)) {
    showError('Start and end time cannot be the same.'); return;
  }
  if (isRecurring && !dateEnd) {
    showError('Please select an end date for the recurring range.'); return;
  }
  if (isRecurring && dateEnd < date) {
    showError('End date must be on or after start date.'); return;
  }

  const dates = isRecurring ? getWeekdays(date, dateEnd) : [date];
  if (dates.length === 0) { showError('No weekdays found in selected range.'); return; }

  document.getElementById('form-error').classList.remove('visible');

  // Force fresh data before conflict check
  try { await loadData(true); } catch(e) {}

  // Single booking edit (non-recurring)
  if (id && !isRecurring) {
    const conflict = findConflict(room, date, start, end, id);
    if (conflict) {
      const freeAlts = getFreeRoomsForDate(date, start, end, room);
      let msg = `Conflict: ${roomName(room)} is booked ${fmtTime(conflict.start)}–${fmtTime(conflict.end)} by ${conflict.booker}.`;
      if (freeAlts.length > 0) msg += ` Free alternatives: ${freeAlts.map(r => r.name).join(', ')}.`;
      else msg += ' No other rooms are free at this time.';
      showError(msg);
      return;
    }
    try {
      showLoadingOverlay(true);
      const origStatus = bookings.find(b => b.id === id)?.status || 'Confirmed';
      const computedEndDate = endDateOverride || (minutesSinceMidnight(end) < minutesSinceMidnight(start) ? addDaysStr(date, 1) : date);
      const booking = { id, room, booker, purpose, date, start, end, attendees: attendees || '', status: origStatus, endDate: computedEndDate };
      const idx = bookings.findIndex(b => b.id === id);
      if (idx !== -1) bookings[idx] = booking;
      await apiUpdate(booking);
      toast('Booking updated.');
    } catch(err) { toast('Error saving. Try again.', true); } finally { showLoadingOverlay(false); }
    resetForm(); renderTable(); renderActiveNow(); renderStatusGrid();
    return;
  }

  // Recurring edit — delete original, create new bookings for each date in range
  if (id && isRecurring) {
    const conflictDates = dates.filter(d => findConflict(room, d, start, end, id));
    if (conflictDates.length > 0) {
      showError(`Conflicts on ${conflictDates.length} date(s): ${conflictDates.slice(0,3).map(fmtDate).join(', ')}${conflictDates.length > 3 ? '…' : ''}. Resolve conflicts first.`);
      return;
    }
    try {
      showLoadingOverlay(true);
      // Delete original booking
      await apiDelete(id);
      bookings = bookings.filter(b => b.id !== id);
      // Create new bookings for each date
      for (const d of dates) {
        const computedEndDate = minutesSinceMidnight(end) < minutesSinceMidnight(start) ? addDaysStr(d, 1) : d;
        const booking = { id: genId(), room, booker, purpose, date: d, start, end, attendees: attendees || '', status: 'Confirmed', endDate: computedEndDate };
        bookings.push(booking);
        await apiCreate(booking);
      }
      toast(`Booking updated across ${dates.length} date(s).`);
    } catch(err) { toast('Error saving. Try again.', true); } finally { showLoadingOverlay(false); }
    resetForm(); renderTable(); renderActiveNow(); renderStatusGrid();
    return;
  }

  // Recurring / new booking — check conflicts per date
  const conflictDates = [];
  const cleanDates = [];

  for (const d of dates) {
    const conflict = findConflict(room, d, start, end, null);
    if (conflict) conflictDates.push({ date: d, conflict });
    else cleanDates.push(d);
  }

  if (conflictDates.length === 0) {
    // No conflicts — book all directly
    try {
      showLoadingOverlay(true);
      for (const d of dates) {
        const computedEndDate = minutesSinceMidnight(end) < minutesSinceMidnight(start) ? addDaysStr(d, 1) : d;
        const booking = { id: genId(), room, booker, purpose, date: d, start, end, attendees: attendees || '', status: 'Confirmed', endDate: computedEndDate };
        bookings.push(booking);
        await apiCreate(booking);
      }
      toast(dates.length === 1 ? 'Room booked successfully.' : `${dates.length} recurring bookings created (Mon–Fri).`);
    } catch(err) { toast('Error saving. Try again.', true); } finally { showLoadingOverlay(false); }
    resetForm(); renderTable(); renderActiveNow(); renderStatusGrid();
  } else {
    // Show conflict resolution modal
    openConflictModal({ room, booker, purpose, start, end, attendees, cleanDates, conflictDates });
  }
}

// ===== DELETE =====
function deleteBooking(id) {
  const b = bookings.find(x => x.id === id);
  if (!b) return;
  deleteTargetId = id;
  document.getElementById('delete-modal-sub').textContent =
    `Delete booking for ${roomName(b.room)} by ${b.booker} on ${fmtDate(b.date)}?`;
  document.getElementById('delete-modal').style.display = 'flex';
}

async function confirmDelete() {
  if (!deleteTargetId) return;
  const idToDelete = deleteTargetId;
  deleteTargetId = null;
  document.getElementById('delete-modal').style.display = 'none';
  try {
    showLoadingOverlay(true);
    bookings = bookings.filter(b => b.id !== idToDelete);
    await apiDelete(idToDelete);
    toast('Booking deleted.');
  } catch(e) {
    toast('Error deleting booking. Try again.', true);
  } finally {
    showLoadingOverlay(false);
  }
  renderTable();
  renderActiveNow();
  renderStatusGrid();
}

// ===== ADMIN AUTH =====
function requireAdmin() {
  if (adminLoggedIn) {
    showPage('admin');
  } else {
    document.getElementById('login-modal').style.display = 'flex';
    setTimeout(() => document.getElementById('login-pw').focus(), 50);
  }
}

async function doLogout() {
  await supabase.auth.signOut();
  adminLoggedIn = false;
  _sessionToken = null;
  document.getElementById('logout-btn').style.display = 'none';
  showPage('status');
  toast('Logged out.');
}

async function doLogin() {
  const pw = document.getElementById('login-pw').value;
  if (!pw) return;

  // Rate limiting
  if (Date.now() < _loginLockedUntil) {
    const remaining = Math.ceil((_loginLockedUntil - Date.now()) / 1000);
    document.getElementById('login-error').textContent = `Too many attempts. Try again in ${remaining}s.`;
    document.getElementById('login-error').classList.add('visible');
    return;
  }

  try {
    showLoadingOverlay(true);
    const { data, error } = await supabase.auth.signInWithPassword({
      email: ADMIN_EMAIL,
      password: pw
    });
    if (!error && data.session) {
      _loginAttempts = 0;
      _loginLockedUntil = 0;
      _lastActivityAt = Date.now();
      adminLoggedIn = true;
      _sessionToken = data.session.access_token; // kept for compatibility with UI code that checks this is set
      document.getElementById('logout-btn').style.display = '';
      document.getElementById('login-modal').style.display = 'none';
      document.getElementById('login-pw').value = '';
      document.getElementById('login-error').classList.remove('visible');
      showPage('admin');
      toast('Welcome, Admin.');
    } else {
      _loginAttempts++;
      if (_loginAttempts >= MAX_LOGIN_ATTEMPTS) {
        _loginLockedUntil = Date.now() + LOCKOUT_MS;
        _loginAttempts = 0;
        document.getElementById('login-error').textContent = 'Too many failed attempts. Locked for 5 minutes.';
      } else {
        document.getElementById('login-error').textContent = `Incorrect password. ${MAX_LOGIN_ATTEMPTS - _loginAttempts} attempt(s) remaining.`;
      }
      document.getElementById('login-error').classList.add('visible');
      document.getElementById('login-pw').value = '';
      document.getElementById('login-pw').focus();
    }
  } catch(e) {
    document.getElementById('login-error').textContent = 'Connection error. Try again.';
    document.getElementById('login-error').classList.add('visible');
  } finally {
    showLoadingOverlay(false);
  }
}

function closeLogin() {
  document.getElementById('login-modal').style.display = 'none';
  document.getElementById('login-pw').value = '';
  document.getElementById('login-error').classList.remove('visible');
}

// ===== PAGES =====
function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  if (name === 'status') {
    document.querySelectorAll('.nav-tab')[0].classList.add('active');
    renderStatusGrid();
  } else if (name === 'admin') {
    document.querySelectorAll('.nav-tab')[1].classList.add('active');
    renderTable();
    renderActiveNow();
    renderPendingRequests();
    resetForm();
  }
}

// ===== TOAST =====
function toast(msg, isErr, durationMs) {
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' toast-err' : '');
  t.textContent = msg;
  if (durationMs) {
    const fadeStart = Math.max(0, (durationMs - 300) / 1000);
    t.style.animation = `toastIn 0.2s ease, toastOut 0.3s ease ${fadeStart}s forwards`;
  }
  c.appendChild(t);
  setTimeout(() => t.remove(), durationMs || 3100);
}

// ===== CLOCK =====
function updateClock() {
  const now = new Date();
  const h = now.getHours(), m = now.getMinutes();
  const ap = h >= 12 ? 'PM' : 'AM';
  const hr = h % 12 || 12;
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const dateStr = days[now.getDay()] + ', ' + now.getDate() + ' ' + months[now.getMonth()];
  const s = now.getSeconds();
  document.getElementById('clock').textContent = dateStr + '  ' + pad(hr) + ':' + pad(m) + ':' + pad(s) + ' ' + ap;
}

// ===== UTIL =====
function escHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

// ===== REQUEST BOOKING (Public) =====
let reqSubmitting = false;
let rejectTargetId = null;

function openRequestModal(roomId) {
  // Populate room select
  const sel = document.getElementById('req-room');
  sel.innerHTML = '<option value="">Select a room...</option>';
  for (const r of ROOMS) sel.innerHTML += `<option value="${r.id}">${r.name} (${r.floor})</option>`;
  if (roomId) sel.value = roomId;

  document.getElementById('req-date').value = todayStr();
  document.getElementById('req-error').textContent = '';
  document.getElementById('req-error').classList.remove('visible');
  document.getElementById('req-form-view').style.display = '';
  document.getElementById('req-confirm-view').style.display = 'none';
  ['req-booker','req-purpose','req-start','req-end','req-attendees'].forEach(id => document.getElementById(id).value = '');
  const recEl = document.getElementById('req-recurring');
  if (recEl) recEl.checked = false;
  const wrapEl = document.getElementById('req-recurring-end-wrap');
  if (wrapEl) wrapEl.style.display = 'none';
  reqSubmitting = false;
  document.getElementById('request-modal').style.display = 'flex';
}

function closeRequestModal() {
  document.getElementById('request-modal').style.display = 'none';
  const recEl = document.getElementById('req-recurring');
  if (recEl) recEl.checked = false;
  const wrapEl = document.getElementById('req-recurring-end-wrap');
  if (wrapEl) wrapEl.style.display = 'none';
}

function validateReqTimes() {
  const s = document.getElementById('req-start').value;
  const e = document.getElementById('req-end').value;
  const errEl = document.getElementById('req-error');
  if (!s || !e) return;
  const sm = parseTimeToMins(s), em = parseTimeToMins(e);
  if (sm !== null && em !== null && em === sm) {
    errEl.textContent = 'Start and end time cannot be the same.';
    errEl.classList.add('visible');
  } else {
    if (errEl.textContent.includes('cannot be the same')) errEl.classList.remove('visible');
  }
}

async function submitRequest() {
  const room = document.getElementById('req-room').value;
  const booker = document.getElementById('req-booker').value.trim();
  const purpose = document.getElementById('req-purpose').value.trim();
  const date = document.getElementById('req-date').value;
  const start = document.getElementById('req-start').value;
  const end = document.getElementById('req-end').value;
  const attendees = document.getElementById('req-attendees').value;
  const isRecurring = document.getElementById('req-recurring').checked;
  const dateEnd = document.getElementById('req-date-end') ? document.getElementById('req-date-end').value : '';
  const errEl = document.getElementById('req-error');

  if (!room || !booker || !purpose || !date || !start || !end || !attendees) {
    errEl.textContent = 'Please fill in all required fields.';
    errEl.classList.add('visible'); return;
  }
  if (minutesSinceMidnight(end) === minutesSinceMidnight(start)) {
    errEl.textContent = 'Start and end time cannot be the same.';
    errEl.classList.add('visible'); return;
  }
  if (isRecurring && !dateEnd) {
    errEl.textContent = 'Please select an end date for the recurring range.';
    errEl.classList.add('visible'); return;
  }
  if (isRecurring && dateEnd < date) {
    errEl.textContent = 'End date must be on or after start date.';
    errEl.classList.add('visible'); return;
  }
  errEl.classList.remove('visible');

  // Force fresh data from sheet before conflict check to catch bookings made on other devices
  try {
    showLoadingOverlay(true);
    await loadData(true);
  } catch(e) { /* proceed with cached data if fetch fails */ }
  finally { showLoadingOverlay(false); }

  const dates = isRecurring ? getWeekdays(date, dateEnd) : [date];
  if (dates.length === 0) {
    errEl.textContent = 'No weekdays found in selected range.';
    errEl.classList.add('visible'); return;
  }

  // Conflict check — used only for the one-time confirmation notice shown to
  // the requester right after submitting. NOT stored anywhere — admin views
  // compute conflicts live at render time instead (see renderPendingRequests /
  // renderTable), so the warning always reflects current reality and
  // automatically disappears once the conflicting booking is deleted/cancelled,
  // rather than being frozen as stale text forever.
  const conflictByDate = {};
  for (const d of dates) {
    const conflicts = findAllConflicts(room, d, start, end, null);
    if (conflicts.length > 0) conflictByDate[d] = conflicts;
  }
  const conflictDates = Object.keys(conflictByDate);
  const hasConflict = conflictDates.length > 0;
  const totalConflictCount = conflictDates.reduce((sum, d) => sum + conflictByDate[d].length, 0);

  try {
    showLoadingOverlay(true);
    reqSubmitting = true;
    const newBookings = dates.map(d => {
      const computedEndDate = minutesSinceMidnight(end) < minutesSinceMidnight(start) ? addDaysStr(d, 1) : d;
      return { id: genId(), room, booker, purpose, date: d, start, end, attendees: attendees || '', status: 'Pending', endDate: computedEndDate };
    });
    await apiCreateRequestBatch(newBookings);
    newBookings.forEach(b => bookings.push(b));
    document.getElementById('req-form-view').style.display = 'none';
    document.getElementById('req-confirm-view').style.display = '';
    reqSubmitting = false;

    // Show conflict notice on confirmation screen if overlaps detected
    const noticeEl = document.getElementById('req-conflict-notice');
    if (hasConflict && noticeEl) {
      const firstDate = conflictDates[0];
      const first = conflictByDate[firstDate][0];
      const isPending = first.status === 'Pending';
      const statusLabel = isPending ? 'a pending request' : 'a confirmed booking';
      const dayCountNote = conflictDates.length > 1 ? ` — ${conflictDates.length} of ${dates.length} days affected (${totalConflictCount} overlapping booking(s) total)` : (totalConflictCount > 1 ? ` — ${totalConflictCount} overlapping bookings that day` : '');
      noticeEl.style.display = '';
      noticeEl.innerHTML = `⚠️ <strong>Note:</strong> ${roomName(room)} already has ${statusLabel} from ${fmtTime(first.start)}–${fmtTime(first.end)} on ${fmtDate(conflictDates[0])} by ${first.booker}${dayCountNote}. Your request has been submitted — please check with the admin for confirmation.`;
    } else if (noticeEl) {
      noticeEl.style.display = 'none';
    }

    launchConfetti();
    updatePendingDot();
  } catch(e) {
    errEl.textContent = 'Error submitting request. Please try again.';
    errEl.classList.add('visible');
    reqSubmitting = false;
  } finally {
    showLoadingOverlay(false);
  }
}

// ===== PENDING REQUESTS (Admin) =====
function updatePendingDot() {
  const count = bookings.filter(b => b.status === 'Pending').length;
  document.getElementById('nav-pending-dot').style.display = count > 0 ? '' : 'none';
}

function renderPendingRequests() {
  const pending = bookings.filter(b => b.status === 'Pending');
  const section = document.getElementById('pending-section');
  const list = document.getElementById('pending-list');
  document.getElementById('pending-count').textContent = pending.length;

  if (pending.length === 0) {
    section.style.display = 'none';
    updatePendingDot();
    return;
  }
  section.style.display = '';
  updatePendingDot();

  const today = todayStr();
  list.innerHTML = pending.sort((a,b) => {
    // Expired (date already passed) requests sink to the bottom — they're no
    // longer actionable and shouldn't bury requests that still need a decision.
    const aExpired = a.date < today, bExpired = b.date < today;
    if (aExpired !== bExpired) return aExpired ? 1 : -1;
    return (a.date+a.start) < (b.date+b.start) ? -1 : 1;
  }).map(b => {
    const isExpired = b.date < today;
    const liveConflicts = getLiveConflicts(b);
    let conflictNote = '';
    if (liveConflicts.length > 0 && b.conflictResolved) {
      conflictNote = `<div class="pending-meta" style="color:var(--text-muted);margin-top:2px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        ✓ Resolved${b.conflictNote ? ': ' + escHtml(b.conflictNote) : ''}
        <button class="btn btn-ghost btn-sm" style="padding:2px 8px;font-size:11px;" onclick="toggleConflictResolved('${b.id}')">Undo</button>
      </div>`;
    } else if (liveConflicts.length > 0) {
      conflictNote = `<div class="pending-meta" style="color:var(--danger);font-weight:500;margin-top:2px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <span>${escHtml(formatLiveConflictNote(liveConflicts))}</span>
        <button class="btn btn-ghost btn-sm" style="padding:2px 8px;font-size:11px;flex-shrink:0;" onclick="toggleConflictResolved('${b.id}')">Mark Resolved</button>
      </div>`;
    }
    return `
    <div class="pending-item" id="pending-item-${b.id}">
      <div class="pending-item-top">
        <div style="display:flex;align-items:flex-start;gap:10px;">
          <input type="checkbox" class="booking-cb pending-cb" data-id="${b.id}" onchange="onPendingCbChange()" style="margin-top:3px;accent-color:var(--warn);width:15px;height:15px;cursor:pointer;flex-shrink:0;">
          <div>
            <div class="pending-room-name">${escHtml(roomName(b.room))}${isExpired ? ' <span style="font-size:11px;font-weight:600;color:var(--text-faint);background:var(--surface2);padding:2px 8px;border-radius:999px;vertical-align:middle;">⏰ Date passed</span>' : ''}</div>
            <div class="pending-meta">${escHtml(b.booker)}${b.purpose ? ' &middot; ' + escHtml(displayPurpose(b.purpose)) : ''}</div>
            <div class="pending-meta">${fmtDate(b.date)} &middot; ${fmtTime(b.start)} – ${fmtTime(b.end)}${b.attendees ? ' &middot; ' + b.attendees + ' attendees' : ''}</div>
            ${conflictNote}
          </div>
        </div>
      </div>
      <div class="pending-actions">
        <button class="btn btn-sm btn-approve" onclick="approvePending('${b.id}')">✅ Approve</button>
        <button class="btn btn-sm btn-modify" onclick="toggleModifyForm('${b.id}')">✏️ Modify & Approve</button>
        <button class="btn btn-sm btn-reject" onclick="openRejectModal('${b.id}')">❌ Reject</button>
      </div>
      <div class="modify-form" id="modify-form-${b.id}">
        <div class="form-row">
          <div class="form-group" style="grid-column:1/-1"><label>Room</label><select id="mod-room-${b.id}">${ROOMS.map(r => `<option value="${r.id}" ${r.id === b.room ? 'selected' : ''}>${r.name}</option>`).join('')}</select></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>Date</label><input type="date" id="mod-date-${b.id}" value="${b.date}"></div>
          <div class="form-group"><label>Attendees</label><input type="number" id="mod-att-${b.id}" value="${b.attendees||''}" min="1" max="200" placeholder="—"></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>Start Time</label><input type="time" id="mod-start-${b.id}" value="${b.start}"></div>
          <div class="form-group"><label>End Time</label><input type="time" id="mod-end-${b.id}" value="${b.end}"></div>
        </div>
        <div class="flex-gap" style="margin-top:8px">
          <button class="btn btn-sm btn-approve" onclick="modifyAndApprove('${b.id}')">Confirm & Approve</button>
          <button class="btn btn-sm btn-ghost" onclick="toggleModifyForm('${b.id}')">Cancel</button>
        </div>
      </div>
    </div>
  `;
  }).join('');
}

function toggleModifyForm(id) {
  const f = document.getElementById('modify-form-' + id);
  f.classList.toggle('open');
}

async function approvePending(id) {
  const idx = bookings.findIndex(b => b.id === id);
  if (idx === -1) return;
  const b = bookings[idx];
  // Check conflict against all confirmed bookings (excluding self)
  const conflict = findConflict(b.room, b.date, b.start, b.end, id);
  if (conflict) {
    if (!(await showConfirmModal(`⚠️ Conflict: ${roomName(b.room)} is already booked ${fmtTime(conflict.start)}–${fmtTime(conflict.end)} by ${conflict.booker} on ${fmtDate(conflict.date || b.date)}.\n\nApprove anyway?`, 'Approve Anyway', 'btn-modify'))) return;
  }
  try {
    showLoadingOverlay(true);
    bookings[idx].status = 'Confirmed';
    await apiUpdateStatus(id, 'Confirmed');
    toast('Booking approved ✅');
  } catch(e) { toast('Error approving booking.', true); }
  finally { showLoadingOverlay(false); }
  renderPendingRequests(); renderTable(); renderStatusGrid(); updatePendingDot();
}

async function modifyAndApprove(id) {
  const idx = bookings.findIndex(b => b.id === id);
  if (idx === -1) return;
  const room = document.getElementById('mod-room-' + id)?.value || bookings[idx].room;
  const date = document.getElementById('mod-date-' + id).value;
  const start = document.getElementById('mod-start-' + id).value;
  const end = document.getElementById('mod-end-' + id).value;
  const attendees = document.getElementById('mod-att-' + id).value;
  if (!date || !start || !end) { toast('Please fill in all fields.', true); return; }
  if (minutesSinceMidnight(end) === minutesSinceMidnight(start)) { toast('Start and end time cannot be the same.', true); return; }
  const conflict = findConflict(room, date, start, end, id);
  if (conflict) { if (!(await showConfirmModal(`⚠️ Conflict: ${roomName(room)} is booked ${fmtTime(conflict.start)}–${fmtTime(conflict.end)} by ${conflict.booker}.\n\nApprove anyway?`, 'Approve Anyway', 'btn-modify'))) return; }
  const modEndDate = minutesSinceMidnight(end) < minutesSinceMidnight(start) ? addDaysStr(date, 1) : date;
  const b = { ...bookings[idx], room, date, start, end, attendees: attendees||'', status: 'Confirmed', endDate: modEndDate };
  try {
    showLoadingOverlay(true);
    bookings[idx] = b;
    await apiUpdate(b);
    toast('Booking modified & approved ✅');
  } catch(e) { toast('Error updating booking.', true); }
  finally { showLoadingOverlay(false); }
  renderPendingRequests(); renderTable(); renderStatusGrid(); updatePendingDot();
}

function openRejectModal(id) {
  rejectTargetId = id;
  const b = bookings.find(x => x.id === id);
  document.getElementById('reject-modal-sub').textContent =
    b ? `Reject booking for ${roomName(b.room)} by ${b.booker} on ${fmtDate(b.date)}?` : 'This request will be removed.';
  document.getElementById('reject-reason').value = '';
  document.getElementById('reject-modal').style.display = 'flex';
}

async function confirmReject() {
  if (!rejectTargetId) return;
  const id = rejectTargetId; rejectTargetId = null;
  document.getElementById('reject-modal').style.display = 'none';
  try {
    showLoadingOverlay(true);
    const idx = bookings.findIndex(b => b.id === id);
    if (idx !== -1) bookings[idx].status = 'Rejected';
    await apiUpdateStatus(id, 'Rejected');
    toast('Request rejected.');
  } catch(e) { toast('Error rejecting request.', true); }
  finally { showLoadingOverlay(false); }
  renderPendingRequests(); renderTable(); renderStatusGrid(); updatePendingDot();
}

// ===== PENDING BULK SELECTION =====
function getPendingSelectedIds() {
  return Array.from(document.querySelectorAll('.pending-cb:checked')).map(cb => cb.dataset.id);
}

function updatePendingBulkBar() {
  const ids = getPendingSelectedIds();
  const bar = document.getElementById('pending-bulk-bar');
  const label = document.getElementById('pending-bulk-label');
  if (!bar) return;
  bar.style.display = ids.length > 0 ? 'flex' : 'none';
  if (label) label.textContent = ids.length + ' selected';
  const selAll = document.getElementById('pending-select-all');
  const allCbs = document.querySelectorAll('.pending-cb');
  if (selAll) {
    selAll.checked = allCbs.length > 0 && ids.length === allCbs.length;
    selAll.indeterminate = ids.length > 0 && ids.length < allCbs.length;
  }
}

function onPendingCbChange() { updatePendingBulkBar(); }

function togglePendingSelectAll(masterCb) {
  document.querySelectorAll('.pending-cb').forEach(cb => cb.checked = masterCb.checked);
  updatePendingBulkBar();
}

function clearPendingSelection() {
  document.querySelectorAll('.pending-cb').forEach(cb => cb.checked = false);
  const sa = document.getElementById('pending-select-all');
  if (sa) { sa.checked = false; sa.indeterminate = false; }
  updatePendingBulkBar();
}

async function bulkApprovePending() {
  const ids = getPendingSelectedIds();
  if (ids.length === 0) return;
  if (!(await showConfirmModal(`Approve ${ids.length} pending request(s)?`, 'Approve All', 'btn-approve'))) return;
  showLoadingOverlay(true);
  let conflicted = 0;
  const toApprove = [];
  try {
    for (const id of ids) {
      const idx = bookings.findIndex(b => b.id === id);
      if (idx === -1) continue;
      const b = bookings[idx];
      const conflict = findConflict(b.room, b.date, b.start, b.end, id);
      if (conflict) { conflicted++; continue; } // skip conflicting
      bookings[idx].status = 'Confirmed';
      toApprove.push(id);
    }
    if (toApprove.length > 0) await apiUpdateStatusBatch(toApprove, 'Confirmed');
    let msg = `${toApprove.length} request(s) approved ✅`;
    if (conflicted > 0) msg += ` — ${conflicted} skipped due to conflicts.`;
    toast(msg);
  } catch(e) { toast('Error during bulk approve.', true); }
  finally { showLoadingOverlay(false); }
  renderPendingRequests(); renderTable(); renderStatusGrid(); updatePendingDot();
}

async function bulkRejectPending() {
  const ids = getPendingSelectedIds();
  if (ids.length === 0) return;
  if (!(await showConfirmModal(`Reject ${ids.length} pending request(s)? They will be marked Rejected.`, 'Reject All', 'btn-danger'))) return;
  showLoadingOverlay(true);
  let rejected = 0;
  try {
    for (const id of ids) {
      const idx = bookings.findIndex(b => b.id === id);
      if (idx !== -1) {
        bookings[idx].status = 'Rejected';
        await apiUpdateStatus(id, 'Rejected');
        rejected++;
      }
    }
    toast(`${rejected} request(s) rejected.`);
  } catch(e) { toast('Error during bulk reject.', true); }
  finally { showLoadingOverlay(false); }
  renderPendingRequests(); renderTable(); renderStatusGrid(); updatePendingDot();
}

// ===== BULK SELECTION (Admin table) =====
function getSelectedIds() {
  return Array.from(document.querySelectorAll('.row-cb:checked')).map(cb => cb.dataset.id);
}

function updateBulkBar() {
  const ids = getSelectedIds();
  const bar = document.getElementById('bulk-bar');
  const label = document.getElementById('bulk-count-label');
  if (!bar) return;
  if (ids.length > 0) {
    bar.classList.add('visible');
    label.textContent = ids.length + ' selected';
  } else {
    bar.classList.remove('visible');
  }
  // Sync select-all checkbox
  const allCbs = document.querySelectorAll('.row-cb');
  const selAll = document.getElementById('select-all-cb');
  if (selAll) {
    selAll.checked = allCbs.length > 0 && ids.length === allCbs.length;
    selAll.indeterminate = ids.length > 0 && ids.length < allCbs.length;
  }
}

function onRowCbChange() { updateBulkBar(); }

function toggleSelectAll(masterCb) {
  document.querySelectorAll('.row-cb').forEach(cb => cb.checked = masterCb.checked);
  updateBulkBar();
}

function clearBulkSelection() {
  document.querySelectorAll('.row-cb').forEach(cb => cb.checked = false);
  const sa = document.getElementById('select-all-cb');
  if (sa) { sa.checked = false; sa.indeterminate = false; }
  updateBulkBar();
}

async function bulkApprove() {
  const ids = getSelectedIds();
  if (ids.length === 0) return;
  if (!(await showConfirmModal(`Approve ${ids.length} booking(s)?`, 'Approve All', 'btn-approve'))) return;
  showLoadingOverlay(true);
  try {
    ids.forEach(id => {
      const idx = bookings.findIndex(b => b.id === id);
      if (idx !== -1) bookings[idx].status = 'Confirmed';
    });
    await apiUpdateStatusBatch(ids, 'Confirmed');
    toast(`${ids.length} booking(s) approved.`);
  } catch(e) { toast('Error during bulk approve.', true); }
  finally { showLoadingOverlay(false); }
  renderPendingRequests(); renderTable(); renderStatusGrid(); updatePendingDot();
}

async function bulkCancel() {
  const ids = getSelectedIds();
  if (ids.length === 0) return;
  if (!(await showConfirmModal(`Cancel ${ids.length} booking(s)?`, 'Cancel Bookings', 'btn-danger'))) return;
  showLoadingOverlay(true);
  try {
    await apiUpdateStatusBatch(ids, 'Cancelled');
    ids.forEach(id => {
      const idx = bookings.findIndex(b => b.id === id);
      if (idx !== -1) bookings[idx].status = 'Cancelled';
    });
    toast(`${ids.length} booking(s) cancelled.`);
  } catch(e) { toast('Error during bulk cancel.', true); }
  finally { showLoadingOverlay(false); }
  renderTable(); renderActiveNow(); renderStatusGrid(); renderPendingRequests(); updatePendingDot();
}

async function bulkDelete() {
  const ids = getSelectedIds();
  if (ids.length === 0) return;
  if (!(await showConfirmModal(`Permanently delete ${ids.length} booking(s)? This cannot be undone.`, 'Delete Permanently', 'btn-danger'))) return;
  showLoadingOverlay(true);
  try {
    for (const id of ids) {
      await apiDelete(id);
      bookings = bookings.filter(b => b.id !== id);
    }
    toast(`${ids.length} booking(s) deleted.`);
  } catch(e) { toast('Error during bulk delete.', true); }
  finally { showLoadingOverlay(false); }
  renderTable(); renderActiveNow(); renderStatusGrid(); renderPendingRequests();
}

// ===== TIMELINE TOOLTIP =====
let _tlTooltipTimeout = null;

function showTlTooltip(e, el) {
  if (_tlTooltipTimeout) { clearTimeout(_tlTooltipTimeout); _tlTooltipTimeout = null; }
  const tip = document.getElementById('tl-tooltip');
  document.getElementById('tl-tip-room').textContent = el.dataset.booker || '';
  document.getElementById('tl-tip-time').textContent = el.dataset.time || '';
  document.getElementById('tl-tip-purpose').textContent = el.dataset.purpose || '';
  const att = el.dataset.att;
  document.getElementById('tl-tip-att').textContent = att ? att + ' attendees' : '';

  // Position: use touch or mouse coords
  const isTouchEvt = e.type === 'touchstart';
  const clientX = isTouchEvt ? e.touches[0].clientX : e.clientX;
  const clientY = isTouchEvt ? e.touches[0].clientY : e.clientY;

  tip.classList.add('visible');

  // Position after browser has rendered (to get size)
  requestAnimationFrame(() => {
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = clientX + 12;
    let top = clientY - th / 2;
    if (left + tw > vw - 8) left = clientX - tw - 12;
    if (top < 8) top = 8;
    if (top + th > vh - 8) top = vh - th - 8;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  });

  if (isTouchEvt) {
    // Auto-hide after 3s on touch
    _tlTooltipTimeout = setTimeout(hideTlTooltip, 3000);
  }
}

function hideTlTooltip() {
  if (_tlTooltipTimeout) { clearTimeout(_tlTooltipTimeout); _tlTooltipTimeout = null; }
  document.getElementById('tl-tooltip').classList.remove('visible');
}

function hideTlTooltipDelayed() {
  _tlTooltipTimeout = setTimeout(hideTlTooltip, 2800);
}

// Hide tooltip on scroll (important for mobile)
document.addEventListener('scroll', hideTlTooltip, true);

// Warn before leaving with unsaved form data
window.addEventListener('beforeunload', e => {
  const booker = document.getElementById('f-booker')?.value;
  const editId = document.getElementById('edit-id')?.value;
  if (booker && adminLoggedIn) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ===== INIT =====
async function init() {
  populateRoomSelects();
  document.getElementById('f-date').value = todayStr();
  updateClock();
  setInterval(updateClock, 1000); // clock ticks every second, independent of data refresh
  await loadData();
  updatePendingDot();
  renderStatusGrid();
  renderTimeline();
  setInterval(async () => {
    if (document.hidden) return; // tab in background / screen off — skip this cycle entirely, no API call
    await loadData(true);
    updatePendingDot();
    // Only render the active page, skip timeline unless open
    if (document.getElementById('page-status').classList.contains('active')) {
      renderStatusGrid();
      const tlWrap = document.getElementById('timeline-wrap');
      if (tlWrap && tlWrap.style.display !== 'none') renderTimeline();
    }
    if (document.getElementById('page-admin').classList.contains('active')) {
      renderTable();
      renderActiveNow();
      renderPendingRequests();
    }
  }, 60000);

  // When the tab becomes visible again after being backgrounded, refresh
  // immediately (don't make the user wait up to 60s for stale data to catch up)
  document.addEventListener('visibilitychange', async () => {
    if (!document.hidden) {
      await loadData(true);
      updatePendingDot();
      if (document.getElementById('page-status').classList.contains('active')) renderStatusGrid();
      if (document.getElementById('page-admin').classList.contains('active')) {
        renderTable(); renderActiveNow(); renderPendingRequests();
      }
    }
  });

  // PWA install support — safe no-op in browsers without service worker support
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(err => {
      console.error('Service worker registration failed:', err);
    });
  }
}



// ===== SCHEDULE MODAL =====
function openSchedModal(roomId) {
  const room = ROOMS.find(r => r.id === roomId);
  if (!room) return;
  document.getElementById('sched-modal-room').textContent = room.name + ' — ' + room.floor;
  const body = document.getElementById('sched-modal-body');

  const today = new Date();
  today.setHours(0,0,0,0);
  let html = '';

  for (let i = 0; i < 30; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const ds = localDateStr(d);
    const dayName = d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' });
    const isToday = i === 0;
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;

    const dayBookings = bookings
      .filter(b => (b.status === 'Confirmed' || !b.status) && b.room === roomId)
      .map(b => ({ b, span: bookingSpans(b).find(sp => sp.date === ds) }))
      .filter(x => x.span)
      .sort((a, c) => a.span.start - c.span.start);

    let dayHtml = '';
    if (dayBookings.length === 0) {
      dayHtml = '<div class="sched-free-all">Fully available all day</div>';
    } else {
      for (const { b, span } of dayBookings) {
        const isPast = ds < todayStr() || (ds === todayStr() && span.end <= nowMinutes());
        const overnightNote = isOvernight(b)
          ? (span.start === 0
              ? ' <span style="color:var(--text-faint);font-size:11px">(cont. from prev. day)</span>'
              : ' <span style="color:var(--text-faint);font-size:11px">(continues next day)</span>')
          : '';
        dayHtml += '<div class="sched-slot booked" style="display:flex;align-items:center;justify-content:space-between;gap:8px">' +
          '<div style="display:flex;align-items:center;gap:12px;flex:1">' +
          '<div class="sched-slot-time">' + fmtTime(b.start) + ' – ' + fmtTime(b.end) + overnightNote + '</div>' +
          '<div class="sched-slot-info">' +
            '<div class="sched-slot-booker">' + escHtml(b.booker) + '</div>' +
            (b.purpose ? '<div class="sched-slot-purpose">' + escHtml(displayPurpose(b.purpose)) + (b.attendees ? ' &middot; ' + b.attendees + ' attendees' : '') + '</div>' : '') +
          '</div></div>' +
          (!isPast ? '<button class="btn btn-danger btn-sm" style="flex-shrink:0;font-size:11px;padding:4px 10px" onclick="event.stopPropagation();openCancelModal(\'' + b.id + '\')" title="Cancel this booking">Cancel</button>' : '') +
        '</div>';
      }
    }

    const labelClass = isToday ? 'sched-day-label today-label' : 'sched-day-label';
    const todayTag = isToday ? ' &mdash; Today' : '';
    const weekendTag = isWeekend ? ' <span style="color:var(--text-faint);font-weight:400">(Weekend)</span>' : '';

    html += '<div class="sched-day-group">' +
      '<div class="' + labelClass + '">' + dayName + todayTag + weekendTag + '</div>' +
      dayHtml +
    '</div>';
  }

  body.innerHTML = html;
  document.getElementById('sched-modal').style.display = 'flex';
}

function closeSchedModal() {
  document.getElementById('sched-modal').style.display = 'none';
}

function closeSchedIfBg(e) {
  if (e.target === document.getElementById('sched-modal')) closeSchedModal();
}


// ===== CONFLICT RESOLUTION =====
let _conflictSession = null;

function getFreeRoomsForDate(date, start, end, excludeRoom) {
  return ROOMS.filter(r => {
    if (r.id === excludeRoom) return false;
    return !findConflict(r.id, date, start, end, null);
  });
}

function openConflictModal(session) {
  _conflictSession = session;
  // Initialize resolution map: date -> roomId or 'skip'
  session.resolutions = {};
  session.conflictDates.forEach(cd => { session.resolutions[cd.date] = null; });

  const totalDates = session.cleanDates.length + session.conflictDates.length;
  document.getElementById('conflict-modal-desc').textContent =
    `${session.conflictDates.length} of ${totalDates} date(s) have conflicts. Choose an alternative room or skip each date.`;

  renderConflictModal();
  document.getElementById('conflict-modal').style.display = 'flex';
}

function renderConflictModal() {
  const s = _conflictSession;
  let html = '';

  // Show clean dates summary
  if (s.cleanDates.length > 0) {
    html += `<div style="margin-bottom:1rem;padding:10px 12px;background:var(--ok-light);border-radius:var(--radius);font-size:13px;color:var(--ok);">
      <strong>✅ ${s.cleanDates.length} date(s) will be booked in ${roomName(s.room)}:</strong>
      <div style="margin-top:4px;color:var(--text-muted)">${s.cleanDates.map(d => fmtDate(d)).join(' · ')}</div>
    </div>`;
  }

  // Show conflict dates
  s.conflictDates.forEach(cd => {
    const freeRooms = getFreeRoomsForDate(cd.date, s.start, s.end, s.room);
    const chosen = s.resolutions[cd.date];
    const isSkipped = chosen === 'skip';
    const isResolved = chosen && chosen !== 'skip';
    const blockClass = isResolved ? 'resolved' : isSkipped ? '' : 'has-conflict';

    html += `<div class="conflict-date-block ${blockClass}" id="cblock-${cd.date}">
      <div class="conflict-date-label">${fmtDate(cd.date)}</div>
      <div class="conflict-reason">⚠️ ${roomName(s.room)} booked ${fmtTime(cd.conflict.start)}–${fmtTime(cd.conflict.end)} by ${escHtml(cd.conflict.booker)}</div>`;

    if (freeRooms.length > 0) {
      html += `<div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;">Available alternatives:</div>
        <div class="conflict-alts">`;
      freeRooms.forEach(r => {
        const sel = chosen === r.id ? 'selected' : '';
        html += `<button class="alt-btn ${sel}" onclick="selectAlt('${cd.date}','${r.id}')">${escHtml(r.name)}<span style="opacity:0.6;font-size:11px;margin-left:4px">${escHtml(r.floor)}</span></button>`;
      });
      html += `<button class="alt-btn skip-btn ${isSkipped ? 'selected' : ''}" onclick="selectAlt('${cd.date}','skip')">Skip this date</button>`;
      html += `</div>`;
    } else {
      html += `<div style="font-size:12px;color:var(--text-muted);margin-top:4px;">No rooms available at this time — this date will be skipped.</div>`;
      s.resolutions[cd.date] = 'skip';
    }

    if (isResolved) {
      html += `<div class="conflict-resolved-label" style="margin-top:8px;">✅ Will book ${roomName(chosen)}</div>`;
    } else if (isSkipped) {
      html += `<div style="font-size:12px;color:var(--text-muted);margin-top:8px;">⏭️ Skipping this date</div>`;
    }

    html += `</div>`;
  });

  document.getElementById('conflict-modal-body').innerHTML = html;
}

function selectAlt(date, roomId) {
  _conflictSession.resolutions[date] = roomId;
  renderConflictModal();
}

function closeConflictModal() {
  document.getElementById('conflict-modal').style.display = 'none';
  _conflictSession = null;
}

async function confirmConflictResolution() {
  const s = _conflictSession;
  // Check all conflict dates have a resolution
  const unresolved = s.conflictDates.filter(cd => s.resolutions[cd.date] === null);
  if (unresolved.length > 0) {
    toast('Please choose an alternative or skip for all conflicted dates.', true);
    return;
  }

  document.getElementById('conflict-modal').style.display = 'none';

  try {
    showLoadingOverlay(true);
    let count = 0;

    // Book clean dates with original room
    for (const d of s.cleanDates) {
      const computedEndDate = minutesSinceMidnight(s.end) < minutesSinceMidnight(s.start) ? addDaysStr(d, 1) : d;
      const booking = { id: genId(), room: s.room, booker: s.booker, purpose: s.purpose, date: d, start: s.start, end: s.end, attendees: s.attendees || '', status: 'Confirmed', endDate: computedEndDate };
      bookings.push(booking);
      await apiCreate(booking);
      count++;
    }

    // Book conflict dates with chosen rooms
    for (const cd of s.conflictDates) {
      const chosenRoom = s.resolutions[cd.date];
      if (chosenRoom === 'skip') continue;
      const computedEndDate = minutesSinceMidnight(s.end) < minutesSinceMidnight(s.start) ? addDaysStr(cd.date, 1) : cd.date;
      const booking = { id: genId(), room: chosenRoom, booker: s.booker, purpose: s.purpose, date: cd.date, start: s.start, end: s.end, attendees: s.attendees || '', status: 'Confirmed', endDate: computedEndDate };
      bookings.push(booking);
      await apiCreate(booking);
      count++;
    }

    const skipped = s.conflictDates.filter(cd => s.resolutions[cd.date] === 'skip').length;
    let msg = `${count} booking(s) created.`;
    if (skipped > 0) msg += ` ${skipped} date(s) skipped.`;
    toast(msg);
  } catch(err) {
    toast('Error saving bookings. Try again.', true);
  } finally {
    showLoadingOverlay(false);
  }

  _conflictSession = null;
  resetForm();
  renderTable();
  renderActiveNow();
  renderStatusGrid();
}


// ===== REQUESTER CANCELLATION =====
let _cancelBookingId = null;
let _cancelModalMode = 'cancel'; // 'cancel' or 'release'

function openCancelModal(bookingId) {
  const b = bookings.find(x => x.id === bookingId);
  if (!b) return;
  _cancelBookingId = bookingId;
  _cancelModalMode = 'cancel';
  document.getElementById('cancel-modal-title').textContent = 'Cancel Your Booking';
  document.getElementById('cancel-modal-sub').textContent = 'Enter your name to verify and cancel your booking.';
  const confirmBtn = document.getElementById('cancel-modal-confirm-btn');
  confirmBtn.textContent = 'Cancel My Booking';
  confirmBtn.className = 'btn btn-danger';
  document.getElementById('cancel-booking-card').innerHTML =
    '<div class="room-name">' + escHtml(roomName(b.room)) + '</div>' +
    '<div class="meta">' + fmtDate(b.date) + ' &middot; ' + fmtTime(b.start) + ' – ' + fmtTime(b.end) +
    (b.purpose ? ' &middot; ' + escHtml(displayPurpose(b.purpose)) : '') + '</div>';
  document.getElementById('cancel-name-input').value = '';
  document.getElementById('cancel-error').classList.remove('visible');
  // Close schedule modal first, then open cancel modal
  document.getElementById('sched-modal').style.display = 'none';
  document.getElementById('cancel-modal').style.display = 'flex';
}

// Same name-verification security model as cancel — but ends the booking NOW
// instead of at its scheduled time, freeing the room immediately.
function openReleaseModal(bookingId) {
  const b = bookings.find(x => x.id === bookingId);
  if (!b) return;
  _cancelBookingId = bookingId;
  _cancelModalMode = 'release';
  document.getElementById('cancel-modal-title').textContent = 'Release Room Early';
  document.getElementById('cancel-modal-sub').textContent = 'Enter your name to verify and free this room right now.';
  const confirmBtn = document.getElementById('cancel-modal-confirm-btn');
  confirmBtn.textContent = 'Release Room Now';
  confirmBtn.className = 'btn btn-approve';
  document.getElementById('cancel-booking-card').innerHTML =
    '<div class="room-name">' + escHtml(roomName(b.room)) + '</div>' +
    '<div class="meta">' + fmtDate(b.date) + ' &middot; ' + fmtTime(b.start) + ' – ' + fmtTime(b.end) +
    (b.purpose ? ' &middot; ' + escHtml(displayPurpose(b.purpose)) : '') + '</div>';
  document.getElementById('cancel-name-input').value = '';
  document.getElementById('cancel-error').classList.remove('visible');
  document.getElementById('cancel-modal').style.display = 'flex';
}

function closeCancelModal() {
  document.getElementById('cancel-modal').style.display = 'none';
  _cancelBookingId = null;
  // Reopen schedule modal so user can continue browsing — only relevant for
  // the cancel flow, which is always entered from within it. Release is
  // opened directly from the room card, so there's nothing to return to.
  if (_cancelModalMode === 'cancel') {
    document.getElementById('sched-modal').style.display = 'flex';
  }
}

async function confirmCancelOrRelease() {
  const b = bookings.find(x => x.id === _cancelBookingId);
  if (!b) return;
  const entered = document.getElementById('cancel-name-input').value.trim().toLowerCase();
  const actual = b.booker.trim().toLowerCase();
  if (entered !== actual) {
    document.getElementById('cancel-error').classList.add('visible');
    return;
  }
  document.getElementById('cancel-error').classList.remove('visible');
  try {
    showLoadingOverlay(true);
    if (_cancelModalMode === 'release') {
      if (bookingTimeStatus(b) !== 'active') {
        toast('This booking is no longer active.', true);
        closeCancelModal();
        return;
      }
      // End the booking right now instead of at its scheduled time. Use the
      // ACTUAL current date (not the booking's original date) for endDate —
      // correct whether this is being released on its start day or, for an
      // overnight booking, on its continuation day after midnight.
      const now = new Date();
      const nowHHMM = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
      await apiReleaseOwn(b.id, entered, nowHHMM + ':00', todayStr());
      b.end = nowHHMM;
      b.endDate = todayStr();
      closeCancelModal();
      toast('Room released — now available.');
    } else {
      // Mark as Cancelled — server re-verifies the name match, keeps record
      await apiCancelOwn(_cancelBookingId, entered);
      const idx = bookings.findIndex(x => x.id === _cancelBookingId);
      if (idx !== -1) bookings[idx].status = 'Cancelled';
      closeCancelModal();
      closeSchedModal();
      toast('Booking cancelled successfully.');
    }
    renderStatusGrid();
    updatePendingDot();
    if (document.getElementById('page-admin').classList.contains('active')) {
      renderTable(); renderActiveNow(); renderPendingRequests();
    }
  } catch(e) {
    toast('Error — please try again.', true);
  } finally {
    showLoadingOverlay(false);
  }
  _cancelBookingId = null;
}



function getTimelineTargetDate() {
  const today = todayStr();
  if (timelineDay === 'yesterday') return addDaysStr(today, -1);
  if (timelineDay === 'tomorrow') return addDaysStr(today, 1);
  if (timelineDay === 'custom') {
    const cv = document.getElementById('tl-custom-date')?.value;
    return cv || today;
  }
  return today;
}

function renderTimeline() {
  const container = document.getElementById('tl-bar-inner');
  if (!container) return;

  const today = todayStr();
  const now = nowMinutes();
  const DAY_MINS = 1440;

  const targetDate = getTimelineTargetDate();
  const isToday = targetDate === today;

  // Hour tick ruler (every 2 hours for readability)
  const TICK_HOURS = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23];
  const tickLabels = TICK_HOURS.map(h => {
    const label = h === 0 ? '12a' : h < 12 ? h + 'a' : h === 12 ? '12p' : (h-12) + 'p';
    const leftPct = (h * 60 / DAY_MINS) * 100;
    return `<div class="tl-ruler-tick" style="position:absolute;left:${leftPct}%">${label}</div>`;
  }).join('');

  // 24 light grid hour dividers on each track
  let gridHtml = '';
  for (let h = 1; h < 24; h++) {
    const leftPct = (h / 24) * 100;
    gridHtml += `<div style="position:absolute;top:0;bottom:0;left:${leftPct}%;width:1px;background:rgba(0,0,0,0.06);"></div>`;
  }

  // Now line pct
  const nowPct = (now / DAY_MINS) * 100;

  const tlFloorFilter = document.getElementById('floor-filter')?.value || '';
  let rowsHtml = '';
  for (const room of ROOMS) {
    if (tlFloorFilter && room.floor !== tlFloorFilter) continue;
    const roomBookings = bookings.filter(b =>
      b.room === room.id && (b.status === 'Confirmed' || !b.status)
    );

    // Get spans that fall on targetDate
    let blocksHtml = '';
    for (const b of roomBookings) {
      const spans = bookingSpans(b).filter(s => s.date === targetDate);
      for (const span of spans) {
        const leftPct = (span.start / DAY_MINS) * 100;
        const widthPct = ((span.end - span.start) / DAY_MINS) * 100;
        const remaining = span.end - now;
        const cls = isToday && now >= span.start && remaining <= 30 ? 'ending-soon' : 'confirmed';
        const startFmt = fmtTime(b.start);
        const endFmt = fmtTime(b.end);
        const showLabel = widthPct > 3;
        const showTime = widthPct > 7;
        blocksHtml += `<div class="tl-booking-block ${cls}"
          style="left:${leftPct.toFixed(3)}%;width:${widthPct.toFixed(3)}%"
          data-booker="${escHtml(b.booker)}"
          data-time="${startFmt}–${endFmt}"
          data-purpose="${escHtml(displayPurpose(b.purpose) || '')}"
          data-att="${escHtml(b.attendees || '')}"
          onmouseenter="showTlTooltip(event,this)"
          onmouseleave="hideTlTooltip()"
          ontouchstart="showTlTooltip(event,this)"
          ontouchend="hideTlTooltipDelayed()">
          ${showLabel ? `<div>
            <div class="tl-booking-label">${escHtml(b.booker)}</div>
            ${showTime ? `<div class="tl-booking-time">${startFmt}–${endFmt}</div>` : ''}
          </div>` : ''}
        </div>`;
      }
    }

    // Now line only on today
    const nowLineHtml = isToday
      ? `<div class="tl-now-line" style="left:${nowPct.toFixed(3)}%"><div class="tl-now-dot"></div></div>`
      : '';

    rowsHtml += `<div class="tl-row">
      <div class="tl-room-label">
        ${escHtml(room.name)}
        <div class="tl-room-floor-label">${escHtml(room.floor)}</div>
      </div>
      <div class="tl-track">
        ${gridHtml}
        ${blocksHtml}
        ${nowLineHtml}
      </div>
    </div>`;
  }

  container.innerHTML = `
    <div style="position:relative;margin-left:130px;margin-right:14px;height:18px;margin-bottom:2px;">
      ${tickLabels}
    </div>
    ${rowsHtml}
  `;

  // Scroll to current time on Today view
  if (isToday) {
    const barContainer = document.querySelector('.tl-bar-container');
    if (barContainer) {
      const scrollPct = Math.max(0, (nowPct / 100) - 0.2); // show a bit before current time
      barContainer.scrollLeft = barContainer.scrollWidth * scrollPct;
    }
  }
}

function setTimelineDay(day, event) {
  if (event) event.stopPropagation();
  timelineDay = day;
  document.querySelectorAll('.tl-tab').forEach(t => t.classList.remove('tl-tab-active'));
  if (day !== 'custom' && event && event.target) event.target.classList.add('tl-tab-active');
  const wrap = document.getElementById('timeline-wrap');
  const icon = document.getElementById('timeline-toggle-icon');
  if (wrap.style.display === 'none') {
    wrap.style.display = 'block';
    icon.style.transform = 'rotate(0deg)';
  }
  renderTimeline();
}

// Previous/Next buttons — shift relative to whichever date is CURRENTLY shown
// (not always relative to today), so repeated clicks keep walking forward/back
// one day at a time from wherever the user currently is.
function shiftTimelineDay(delta) {
  const current = getTimelineTargetDate();
  const newDate = addDaysStr(current, delta);
  const today = todayStr();
  const yestStr = addDaysStr(today, -1);
  const tomStr = addDaysStr(today, 1);

  document.querySelectorAll('.tl-tab').forEach(t => t.classList.remove('tl-tab-active'));
  document.getElementById('tl-custom-date').value = newDate;

  if (newDate === yestStr) {
    timelineDay = 'yesterday';
    document.getElementById('tl-tab-yesterday')?.classList.add('tl-tab-active');
  } else if (newDate === today) {
    timelineDay = 'today';
    document.getElementById('tl-tab-today')?.classList.add('tl-tab-active');
  } else if (newDate === tomStr) {
    timelineDay = 'tomorrow';
    document.getElementById('tl-tab-tomorrow')?.classList.add('tl-tab-active');
  } else {
    timelineDay = 'custom';
  }

  const wrap = document.getElementById('timeline-wrap');
  const icon = document.getElementById('timeline-toggle-icon');
  if (wrap.style.display === 'none') {
    wrap.style.display = 'block';
    icon.style.transform = 'rotate(0deg)';
  }
  renderTimeline();
}

function toggleTimeline() {
  const wrap = document.getElementById('timeline-wrap');
  const icon = document.getElementById('timeline-toggle-icon');
  const isHidden = wrap.style.display === 'none';
  wrap.style.display = isHidden ? 'block' : 'none';
  icon.style.transform = isHidden ? 'rotate(0deg)' : 'rotate(-90deg)';
  if (isHidden) renderTimeline();
}



// ===== CONFETTI =====
function launchConfetti() {
  const colors = ['#1E4A3C','#2E6B56','#C0392B','#F39C12','#3498DB','#9B59B6','#1ABC9C'];
  const container = document.createElement('div');
  container.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9999;overflow:hidden;';
  document.body.appendChild(container);

  for (let i = 0; i < 80; i++) {
    const piece = document.createElement('div');
    const color = colors[Math.floor(Math.random() * colors.length)];
    const size = Math.random() * 8 + 5;
    const left = Math.random() * 100;
    const delay = Math.random() * 0.6;
    const duration = Math.random() * 1.5 + 1.5;
    const rotation = Math.random() * 360;
    const shape = Math.random() > 0.5 ? '50%' : '0';

    piece.style.cssText = `
      position:absolute;
      width:${size}px;height:${size}px;
      background:${color};
      border-radius:${shape};
      left:${left}%;top:-10px;
      opacity:1;
      animation:confettiFall ${duration}s ${delay}s ease-in forwards;
      transform:rotate(${rotation}deg);
    `;
    container.appendChild(piece);
  }

  // Remove after animation
  setTimeout(() => container.remove(), 3500);
}

// ===== EXPORT EXCEL =====
function exportExcel() {
  const headers = ['Room','Floor','Booked By','Purpose','Date','Start Time','End Time','Attendees','Status','Conflict Note'];
  const rows = [...bookings].sort((a,b) => {
    const da = a.date + a.start, db = b.date + b.start;
    return da < db ? -1 : da > db ? 1 : 0;
  }).map(b => {
    const room = ROOMS.find(r => r.id === b.room) || {};
    let status;
    if (b.status === 'Pending') status = 'Pending';
    else if (b.status === 'Rejected') status = 'Rejected';
    else if (b.status === 'Cancelled') status = 'Cancelled';
    else {
      const ts = bookingTimeStatus(b);
      status = ts === 'past' ? 'Past' : ts === 'active' ? 'Active' : 'Upcoming';
    }
    return {
      'Room': room.name || b.room,
      'Floor': room.floor || '',
      'Booked By': b.booker,
      'Purpose': displayPurpose(b.purpose) || '',
      'Date': b.date,
      'Start Time': fmtTime(b.start),
      'End Time': fmtTime(b.end),
      'Attendees': b.attendees || '',
      'Status': status,
      'Conflict Note': b.conflictResolved ? (b.conflictNote || '(resolved, no note)') : ''
    };
  });
  if (typeof XLSX === 'undefined') {
    toast('Loading Excel library, please try again in a moment.', true);
    return;
  }
  const ws = XLSX.utils.json_to_sheet(rows, { header: headers });
  ws['!cols'] = [20,18,22,28,14,14,14,12,12,30].map(w => ({ wch: w }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Room Bookings');
  XLSX.writeFile(wb, 'room-bookings-' + todayStr() + '.xlsx');
  toast('Excel file downloaded.');
}

init();
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    
  });
}
