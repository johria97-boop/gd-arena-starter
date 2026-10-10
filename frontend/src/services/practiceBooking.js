export const PRACTICE_BOOKING_KEY = 'gd-arena-next-practice';

export function loadPracticeBooking(storage = globalThis.localStorage) {
  if (!storage) return null;
  try {
    const value = JSON.parse(storage.getItem(PRACTICE_BOOKING_KEY));
    return /^\d{4}-\d{2}-\d{2}$/.test(value?.date) && /^\d{2}:\d{2}$/.test(value?.time) ? value : null;
  } catch {
    return null;
  }
}

export function savePracticeBooking(booking, storage = globalThis.localStorage) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(booking?.date) || !/^\d{2}:\d{2}$/.test(booking?.time)) return false;
  try {
    storage?.setItem(PRACTICE_BOOKING_KEY, JSON.stringify({ date: booking.date, time: booking.time }));
    return Boolean(storage);
  } catch {
    return false;
  }
}

export function formatPracticeBooking(booking) {
  if (!booking) return '';
  const date = new Date(`${booking.date}T${booking.time}:00`);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString([], { dateStyle: 'long', timeStyle: 'short' });
}
