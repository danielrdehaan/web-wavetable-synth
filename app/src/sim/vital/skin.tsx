import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState, type ReactNode, type RefObject } from 'react'
import defaultText from '../../../../vital-src/default.vitalskin?raw'
import makeThingsDark from './skins/make-things-dark.vitalskin?raw'
import makeThingsLight from './skins/make-things-light.vitalskin?raw'

// Vital's skins (skin.cpp): a .vitalskin is JSON with a value for each of Vital's colours and sizes, and
// "overrides" per section (Oscillator, Filter, Lfo, …) that replace some of them inside that section. In
// Vital a section's components find a colour or value by walking up their parents (JUCE findColour,
// SynthSection::findValue), so an override reaches everything inside its section. CSS custom properties
// inherit the same way: the skin becomes `--sk-*` variables on the window (the globals) and on each
// element marked `data-skin="<section>"` (its overrides), and the interface draws with `var(--sk-*)`.
// Canvas drawing reads the same variables from its own element (useSkinColors), so it follows its
// section too.

/** Skin::kOverrideNames. "All" is the globals (kNone). */
export const SKIN_SECTIONS = [
  'All', 'Logo', 'Header', 'Overlays', 'Oscillator', 'Sample', 'Sub', 'Filter', 'Envelope', 'Lfo', 'RandomLfo', 'Voice',
  'Macro', 'Keyboard', 'All Effects', 'Chorus', 'Compressor', 'Delay', 'Distortion', 'Equalizer', 'Effects Filter',
  'Flanger', 'Phaser', 'Reverb', 'Modulation Drag Drop', 'Modulation Matrix', 'Preset Browser', 'Popup Browser',
  'Advanced', 'Wavetable Editor',
] as const
export type SkinSection = (typeof SKIN_SECTIONS)[number]

/** Skin::kColorNames. */
export const COLOR_KEYS = [
  'Background', 'Body', 'Body Heading Background', 'Heading Text', 'Preset Text', 'Body Text', 'Border', 'Label Background',
  'Label Connection', 'Power Button On', 'Power Button Off',
  'Overlay Screen', 'Lighten Screen', 'Shadow', 'Popup Selector Background', 'Popup Background', 'Popup Border',
  'Text Component Background', 'Text Component Text',
  'Rotary Arc', 'Rotary Arc Disabled', 'Rotary Arc Unselected', 'Rotary Arc Unselected Disabled', 'Rotary Hand', 'Rotary Body',
  'Rotary Body Border',
  'Linear Slider', 'Linear Slider Disabled', 'Linear Slider Unselected', 'Linear Slider Thumb', 'Linear Slider Thumb Disabled',
  'Widget Center Line', 'Widget Primary 1', 'Widget Primary 2', 'Widget Primary Disabled', 'Widget Secondary 1',
  'Widget Secondary 2', 'Widget Secondary Disabled', 'Widget Accent 1', 'Widget Accent 2', 'Widget Background',
  'Modulation Meter', 'Modulation Meter Left', 'Modulation Meter Right', 'Modulation Meter Control',
  'Modulation Button Selected', 'Modulation Button Dragging', 'Modulation Button Unselected',
  'Icon Selector Icon',
  'Icon Button Off', 'Icon Button Off Hover', 'Icon Button Off Pressed', 'Icon Button On', 'Icon Button On Hover',
  'Icon Button On Pressed',
  'UI Button', 'UI Button Text', 'UI Button Hover', 'UI Button Press', 'UI Action Button', 'UI Action Button Hover',
  'UI Action Button Press',
  'Text Editor Background', 'Text Editor Border', 'Text Editor Caret', 'Text Editor Selection',
] as const
export type ColorKey = (typeof COLOR_KEYS)[number]

/** Skin::kValueNames, in Vital's points. */
export const VALUE_KEYS = [
  'Body Rounding', 'Label Height', 'Label Background Height', 'Label Rounding', 'Label Offset', 'Text Component Label Offset',
  'Rotary Option X Offset', 'Rotary Option Y Offset', 'Rotary Option Width', 'Title Width', 'Padding', 'Large Padding',
  'Slider Width', 'Text Component Height', 'Text Component Offset', 'Text Component Font Size', 'Text Button Height',
  'Button Font Size', 'Knob Arc Size', 'Knob Arc Thickness', 'Knob Body Size', 'Knob Handle Length', 'Knob Mod Amount Arc Size',
  'Knob Mod Amount Arc Thickness', 'Knob Mod Meter Arc Size', 'Knob Mod Meter Arc Thickness', 'Knob Offset',
  'Knob Section Height', 'Knob Shadow Width', 'Knob Shadow Offset', 'Modulation Button Width', 'Modulation Font Size',
  'Widget Margin', 'Widget Rounded Corner', 'Widget Line Width', 'Widget Line Boost', 'Widget Fill Center', 'Widget Fill Fade',
  'Widget Fill Boost', 'Wavetable Horizontal Angle', 'Wavetable Vertical Angle', 'Wavetable Draw Width',
  'Wavetable Draw Height', 'Wavetable Y Offset',
] as const
export type ValueKey = (typeof VALUE_KEYS)[number]

export interface SkinLayer { colors: Partial<Record<ColorKey, string>>; values: Partial<Record<ValueKey, number>> }
export interface Skin extends SkinLayer { name: string; overrides: Partial<Record<SkinSection, SkinLayer>> }

/** The custom property for a colour or value: "Widget Primary 1" → --sk-widget-primary-1. */
export const skinVar = (key: ColorKey | ValueKey) => `--sk-${key.toLowerCase().replace(/\s+/g, '-')}`
/** A colour (or value) for a style: var(--sk-widget-primary-1). */
export const sk = (key: ColorKey | ValueKey) => `var(${skinVar(key)})`
/** A skin value as a length: Vital's points at one CSS pixel per point, as the interface is measured. */
export const skPx = (key: ValueKey, scale = 1) => `calc(var(${skinVar(key)}) * ${scale}px)`

/** JUCE Colour::fromString: the hex digits as a 32-bit ARGB number, so "ffffff" is white at alpha 0 and
 *  "0" is transparent black. */
export function argbToCss(s: string): string {
  const n = parseInt(s, 16) >>> 0
  if (!Number.isFinite(n)) return 'transparent'
  const a = (n >>> 24) & 255, r = (n >>> 16) & 255, g = (n >>> 8) & 255, b = n & 255
  const hex = (x: number) => x.toString(16).padStart(2, '0')
  return a === 255 ? `#${hex(r)}${hex(g)}${hex(b)}` : `rgba(${r}, ${g}, ${b}, ${+(a / 255).toFixed(3)})`
}

function layerOf(data: Record<string, unknown> | null | undefined): SkinLayer {
  const layer: SkinLayer = { colors: {}, values: {} }
  if (!data || typeof data !== 'object') return layer
  for (const k of COLOR_KEYS) if (typeof data[k] === 'string') layer.colors[k] = argbToCss(data[k] as string)
  for (const k of VALUE_KEYS) if (typeof data[k] === 'number') layer.values[k] = data[k] as number
  return layer
}

/** A .vitalskin's text as a skin (Skin::jsonToState after updateJson). A colour or value it leaves out
 *  keeps `base`'s (Vital's default skin, which it loads over); section overrides are only its own, as
 *  clearSkin drops the old ones. Throws on text that isn't a skin. */
export function parseSkin(text: string, name: string, base: SkinLayer = DEFAULT_SKIN): Skin {
  const data = JSON.parse(text) as Record<string, unknown>
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not a skin')
  const version = typeof data.synth_version === 'number' ? data.synth_version : 0
  if (version < 0x608) {
    const renamed: [string, string][] = [['Knob Arc Size', 'Knob Size'], ['Knob Arc Thickness', 'Knob Thickness'],
      ['Knob Handle Length', 'Knob Handle Radial Amount'], ['Knob Mod Amount Arc Size', 'Knob Mod Amount Size'],
      ['Knob Mod Amount Arc Thickness', 'Knob Mod Amount Thickness'], ['Knob Mod Meter Arc Size', 'Knob Mod Meter Size'],
      ['Knob Mod Meter Arc Thickness', 'Knob Mod Meter Thickness']]
    for (const [to, from] of renamed) if (data[from] !== undefined) data[to] = data[from]
  }
  if (data['Widget Fill Boost'] === undefined) data['Widget Fill Boost'] = 1.6
  if (data['Widget Line Boost'] === undefined) data['Widget Line Boost'] = 1
  if (version < 0x609) data['Modulation Meter'] = 'ffffffff'

  const own = layerOf(data)
  const overridesIn = (data.overrides ?? {}) as Record<string, Record<string, unknown>>
  const all = layerOf(overridesIn.All)
  const overrides: Skin['overrides'] = {}
  for (const s of SKIN_SECTIONS) {
    if (s === 'All') continue
    const layer = layerOf(overridesIn[s])
    if (Object.keys(layer.colors).length || Object.keys(layer.values).length) overrides[s] = layer
  }
  return {
    name,
    colors: { ...base.colors, ...own.colors, ...all.colors },
    values: { ...base.values, ...own.values, ...all.values },
    overrides,
  }
}

const DEFAULT_SKIN: Skin = parseSkin(defaultText, 'Default', { colors: {}, values: {} })

/** The skins the THEME menu lists: Vital's default, then the bundled ones by name. */
export const BUILTIN_SKINS: Skin[] = [
  DEFAULT_SKIN,
  parseSkin(makeThingsDark, 'Make Things - Dark'),
  parseSkin(makeThingsLight, 'Make Things - Light'),
]

/** The skin as CSS: the globals on `scope` and each section's overrides on its marked elements inside it. */
export function skinCss(skin: Skin, scope = '.vt'): string {
  const decls = (l: SkinLayer) => [
    ...Object.entries(l.colors).map(([k, v]) => `${skinVar(k as ColorKey)}: ${v};`),
    ...Object.entries(l.values).map(([k, v]) => `${skinVar(k as ValueKey)}: ${v};`),
  ].join(' ')
  const out = [`${scope} { ${decls(skin)} }`]
  for (const [s, l] of Object.entries(skin.overrides)) out.push(`${scope} [data-skin="${s}"] { ${decls(l as SkinLayer)} }`)
  return out.join('\n')
}

/** A skin colour or value as the default skin has it at the top level (before any section's override),
 *  for code that draws before it can read its element's style. */
export const defaultColor = (key: ColorKey) => DEFAULT_SKIN.colors[key] ?? '#000000'
export const defaultValue = (key: ValueKey) => DEFAULT_SKIN.values[key] ?? 0

// The chosen skin: the page's ?skin= (by name or file name, e.g. make-things-dark) wins, then the one
// chosen in THEME (kept in this browser), then Vital's default. A skin loaded from a file (Load Skin...)
// is kept too, under its own name.
const CHOSEN_KEY = 'vt-skin'
const LOADED_KEY = 'vt-skin-loaded'
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

function readLoaded(): Skin | null {
  try {
    const saved = JSON.parse(localStorage.getItem(LOADED_KEY) ?? 'null') as { name: string; text: string } | null
    return saved ? parseSkin(saved.text, saved.name) : null
  } catch { return null }
}

interface SkinApi {
  skin: Skin
  /** Names for the THEME menu. */
  names: string[]
  choose: (name: string) => void
  /** Loads a .vitalskin file and chooses it; rejects if it isn't one. */
  load: (file: File) => Promise<void>
  /** Bumped whenever the skin changes, for drawing that reads it from the page. */
  version: number
}

const SkinContext = createContext<SkinApi | null>(null)

export function SkinProvider({ initial, children }: { initial?: string | null; children: ReactNode }) {
  const [loaded, setLoaded] = useState<Skin | null>(readLoaded)
  const [chosen, setChosen] = useState<string>(() => {
    if (initial) return initial
    try { return localStorage.getItem(CHOSEN_KEY) ?? 'Default' } catch { return 'Default' }
  })
  const [version, setVersion] = useState(0)
  const all = useMemo(() => (loaded ? [...BUILTIN_SKINS.filter((s) => s.name !== loaded.name), loaded] : BUILTIN_SKINS), [loaded])
  const skin = all.find((s) => s.name === chosen || slug(s.name) === slug(chosen)) ?? DEFAULT_SKIN
  const choose = useCallback((name: string) => {
    setChosen(name); setVersion((n) => n + 1)
    try { localStorage.setItem(CHOSEN_KEY, name) } catch { /* storage unavailable */ }
  }, [])
  const load = useCallback(async (file: File) => {
    const text = await file.text()
    const name = file.name.replace(/\.vitalskin$/i, '')
    const next = parseSkin(text, name)
    setLoaded(next)
    try { localStorage.setItem(LOADED_KEY, JSON.stringify({ name, text })) } catch { /* too big or unavailable: this session only */ }
    choose(name)
  }, [choose])
  const api = useMemo(() => ({ skin, names: all.map((s) => s.name), choose, load, version }), [skin, all, choose, load, version])
  return <SkinContext.Provider value={api}>{children}</SkinContext.Provider>
}

export function useSkin(): SkinApi {
  const api = useContext(SkinContext)
  if (!api) throw new Error('useSkin outside SkinProvider')
  return api
}

/** The skin's variables as a style sheet, for the window. */
export function SkinStyle({ scope = '.vt' }: { scope?: string }) {
  const { skin } = useSkin()
  const css = useMemo(() => skinCss(skin, scope), [skin, scope])
  return <style>{css}</style>
}

/** Skin colours as `ref`'s element sees them (its section's overrides, else the globals), for canvas
 *  drawing; read again whenever the skin changes. Until the element is there, the default skin's. */
export function useSkinColors<K extends ColorKey>(ref: RefObject<Element | null>, keys: readonly K[]): Record<K, string> {
  const { version, skin } = useContext(SkinContext) ?? { version: 0, skin: DEFAULT_SKIN }
  const read = () => {
    const out = {} as Record<K, string>
    const style = ref.current ? getComputedStyle(ref.current) : null
    for (const k of keys) out[k] = style?.getPropertyValue(skinVar(k)).trim() || defaultColor(k)
    return out
  }
  const [colors, setColors] = useState<Record<K, string>>(read)
  const sig = keys.join('|')
  useLayoutEffect(() => {
    const next = read()
    setColors((prev) => (keys.every((k) => prev[k] === next[k]) ? prev : next))
  }, [version, skin, sig]) // eslint-disable-line react-hooks/exhaustive-deps
  return colors
}

/** Skin values (points) as `ref`'s element sees them, like useSkinColors. */
export function useSkinValues<K extends ValueKey>(ref: RefObject<Element | null>, keys: readonly K[]): Record<K, number> {
  const { version, skin } = useContext(SkinContext) ?? { version: 0, skin: DEFAULT_SKIN }
  const read = () => {
    const out = {} as Record<K, number>
    const style = ref.current ? getComputedStyle(ref.current) : null
    for (const k of keys) {
      const v = parseFloat(style?.getPropertyValue(skinVar(k)) ?? '')
      out[k] = Number.isFinite(v) ? v : defaultValue(k)
    }
    return out
  }
  const [values, setValues] = useState<Record<K, number>>(read)
  const sig = keys.join('|')
  useLayoutEffect(() => {
    const next = read()
    setValues((prev) => (keys.every((k) => prev[k] === next[k]) ? prev : next))
  }, [version, skin, sig]) // eslint-disable-line react-hooks/exhaustive-deps
  return values
}
