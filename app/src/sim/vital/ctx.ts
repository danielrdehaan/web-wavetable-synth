import { createContext, useContext } from 'react'

// The Vital drawing's shared state (store.tsx provides it).

export interface Mod { src: string; dst: string; amt: number; bipolar: boolean; stereo: boolean; bypass: boolean; power: number }

export interface MenuItem { label?: string; on?: boolean; act?: () => void; sep?: boolean; dim?: boolean }
/** A popup menu at stage coordinates. A `dual` menu is Vital's DualPopupSelector (two columns, the left
 *  one choosing the right one's items): a pick applies and the menu stays open; double-clicking the
 *  current item, or clicking elsewhere, closes it. Any other menu (PopupSelector) closes on a pick. */
export interface Menu { items: MenuItem[]; x: number; y: number; cols?: MenuItem[][]; w?: number; dual?: boolean }

/** UI state that isn't a parameter (which tab each column shows, etc.). */
export interface Ui { [k: string]: unknown }

export interface Snap { v: Record<string, number>; mods: Mod[]; ui: Ui }

export interface VitalApi {
  v: Record<string, number>
  /** A value as of the last change (not the last render): what a gesture should build on. */
  get: (id: string) => number | undefined
  set: (id: string, val: number) => void
  mods: Mod[]
  /** The routings as of the last change. */
  getMods: () => Mod[]
  addMod: (src: string, dst: string) => void
  setMod: (i: number, patch: Partial<Mod>) => void
  removeMod: (i: number) => void
  ui: Ui
  setUi: (patch: Ui) => void
  /** Save an undo step (call when a gesture starts). */
  checkpoint: () => void
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
  init: () => void
  /** Replace the patch with one read back from the engine (a loaded preset), plus the UI state that
   *  describes it (preset name, wavetable names, LFO shapes). */
  replace: (values: Record<string, number>, mods: Mod[], uiPatch: Ui) => void
  /** Bumped by init and replace: `from` says whether the engine still has to be reset to match. */
  patch: { id: number; from: 'init' | 'engine' }
  /** The modulator being dragged onto a control, if any. */
  dragSrc: string | null
  beginSourceDrag: (src: string, e: React.PointerEvent, onClick?: () => void) => void
  /** The modulator whose depth rings are shown. */
  focusSrc: string | null
  setFocusSrc: (s: string | null) => void
  menu: Menu | null
  openMenu: (m: Omit<Menu, 'x' | 'y'>, e: { clientX: number; clientY: number }) => void
  closeMenu: () => void
  /** Client pixels → stage pixels (the stage is scaled to fit its column). */
  scale: () => number
  toStage: (cx: number, cy: number) => { x: number; y: number }
  notes: ReadonlySet<number>
  /** performance.now() of the last note-on and of the release (when no key is held). */
  noteOnAt: number
  noteOffAt: number
  setNote: (n: number, on: boolean) => void
  rootRef: React.RefObject<HTMLDivElement | null>
}

export const Ctx = createContext<VitalApi | null>(null)
export const useVital = () => useContext(Ctx)!

