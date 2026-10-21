// Reading audio files as Vital's AudioFormatManager does: the samples at the file's own rate (a
// wavetable splices its file into 2048-sample frames, so it must not be resampled). WAV is read here
// (8/16/24/32-bit integer and 32/64-bit float, its "clm " chunk too); anything else goes through the
// browser's decoder, which hands it back at the audio context's rate.

export interface AudioData { channels: Float32Array[]; sampleRate: number; clm: string }

function readWav(buf: ArrayBuffer): AudioData | null {
  const v = new DataView(buf)
  const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3))
  if (buf.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null
  let format = 0, channels = 0, rate = 0, bits = 0, data: [number, number] | null = null, clm = ''
  for (let o = 12; o + 8 <= buf.byteLength;) {
    const id = tag(o), size = v.getUint32(o + 4, true), body = o + 8
    if (id === 'fmt ') {
      format = v.getUint16(body, true); channels = v.getUint16(body + 2, true); rate = v.getUint32(body + 4, true); bits = v.getUint16(body + 14, true)
      if (format === 0xfffe && size >= 26) format = v.getUint16(body + 24, true)
    } else if (id === 'data') data = [body, Math.min(size, buf.byteLength - body)]
    else if (id === 'clm ') clm = new TextDecoder().decode(new Uint8Array(buf, body, Math.min(size, buf.byteLength - body)))
    o = body + size + (size & 1)
  }
  if (!data || !channels || !rate || (format !== 1 && format !== 3)) return null
  const bytes = bits / 8, frames = Math.floor(data[1] / (bytes * channels))
  const out = Array.from({ length: channels }, () => new Float32Array(frames))
  let p = data[0]
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++, p += bytes) {
      let x: number
      if (format === 3) x = bits === 64 ? v.getFloat64(p, true) : v.getFloat32(p, true)
      else if (bits === 8) x = (v.getUint8(p) - 128) / 128
      else if (bits === 16) x = v.getInt16(p, true) / 32768
      else if (bits === 24) x = (((v.getUint8(p + 2) << 24) | (v.getUint8(p + 1) << 16) | (v.getUint8(p) << 8)) >> 8) / 8388608
      else x = v.getInt32(p, true) / 2147483648
      out[c][i] = x
    }
  }
  return { channels: out, sampleRate: rate, clm }
}

/** The file's channels at its own rate where it can be read directly, else as the browser decodes it. */
export async function readAudioFile(file: Blob, ctx: BaseAudioContext): Promise<AudioData> {
  const buf = await file.arrayBuffer()
  const wav = readWav(buf)
  if (wav) return wav
  const audio = await ctx.decodeAudioData(buf)
  return { channels: Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c).slice()), sampleRate: audio.sampleRate, clm: '' }
}

/** getFadeStyleFromWavetableString: a "<!>" clm string's second token picks no interpolation ('0'),
 *  time ('1') or frequency interpolation (the default) — FileSource::FadeStyle 1, 2 or 3. */
export function clmFadeStyle(clm: string): number {
  if (!clm.startsWith('<!>')) return 3
  const tokens = clm.slice(3).split(' ') // StringArray::addTokens keeps empty tokens between spaces
  if (tokens.length < 2 || !tokens[1]) return 3
  return tokens[1][0] === '0' ? 1 : tokens[1][0] === '1' ? 2 : 3
}

/** getAuthorFromWavetableString: the bracketed name in a "<!>" clm string. */
export function clmAuthor(clm: string): string {
  if (!clm.startsWith('<!>')) return ''
  const a = clm.indexOf('['), b = clm.indexOf(']')
  return a >= 0 && a < b ? clm.slice(a + 1, b) : ''
}
