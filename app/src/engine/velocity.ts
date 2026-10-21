/** Velocity (0–1) of each note a MIDI keyboard is holding. Notes go through the store's held set (so
 *  the on-screen keys light up); EngineSync reads the velocity here, defaulting for mouse and computer
 *  keys. */
export const noteVelocity = new Map<number, number>()
export const DEFAULT_VELOCITY = 0.8
