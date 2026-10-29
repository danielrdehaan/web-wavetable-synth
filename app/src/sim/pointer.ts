import type { PointerEvent as ReactPointerEvent } from 'react'

/** Captures the pointer for a drag, as setPointerCapture does, and makes sure the drag ends. When the
 *  button is let go where the page never hears it (outside the window or the app's pane, or while focus
 *  was elsewhere), the browser drops the capture at the next pointer event without sending a pointerup,
 *  and a drag waiting for one would carry on, turning the control whenever the mouse passed over it.
 *  So if the capture goes before a pointerup or pointercancel came, this sends the element a pointerup
 *  in its place, and its own handlers end the drag. */
export function capturePointer(e: ReactPointerEvent, el: Element = e.currentTarget as Element) {
  const id = e.pointerId
  try { el.setPointerCapture(id) } catch { return /* a synthetic pointer, nothing to capture */ }
  let ended = false
  const onEnd = (ev: Event) => { if ((ev as PointerEvent).pointerId === id) ended = true }
  const onLost = (ev: Event) => {
    const lost = ev as PointerEvent
    if (lost.pointerId !== id) return
    el.removeEventListener('pointerup', onEnd, true)
    el.removeEventListener('pointercancel', onEnd, true)
    el.removeEventListener('lostpointercapture', onLost)
    if (!ended) {
      el.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, cancelable: true, pointerId: id, pointerType: lost.pointerType, isPrimary: lost.isPrimary,
        clientX: lost.clientX, clientY: lost.clientY, screenX: lost.screenX, screenY: lost.screenY,
      }))
    }
  }
  el.addEventListener('pointerup', onEnd, true)
  el.addEventListener('pointercancel', onEnd, true)
  el.addEventListener('lostpointercapture', onLost)
}
