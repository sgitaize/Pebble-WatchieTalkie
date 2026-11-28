import Foundation

/*
 * Sprachnachrichten-Format wie auf der Pebble (watch/src/pkjs/audio.js, main.c):
 * Byte 0 = 1 (IMA-ADPCM, 8 kHz, mono, Start 0 / Index 0, unteres Halbbyte zuerst), danach 4 Bit je Abtastwert.
 */
enum ADPCM {
    static let rate = 8000.0
    private static let step: [Int32] = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
        130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282,
        1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493,
        10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767]
    private static let idxTab: [Int] = [-1, -1, -1, -1, 2, 4, 6, 8]

    /// 8-kHz-PCM → Lautstärke angleichen (Spitze → 90 %, höchstens 8-fach) → ADPCM mit Versionsbyte
    static func encode(_ input: [Int16]) -> Data {
        var pcm = input
        let peak = max(1, pcm.map { Int32($0).magnitude }.max() ?? 1)
        let gain = min(8.0, 29490.0 / Double(peak))
        if gain > 1.05 { pcm = pcm.map { Int16(clamping: Int(((Double($0) * gain)).rounded())) } }
        var out = [UInt8](repeating: 0, count: 1 + (pcm.count + 1) / 2)
        out[0] = 1
        var pred: Int32 = 0, idx = 0
        for (i, s) in pcm.enumerated() {
            var st = step[idx], diff = Int32(s) - pred, code: UInt8 = 0
            if diff < 0 { code = 8; diff = -diff }
            var dq = st >> 3
            if diff >= st { code |= 4; diff -= st; dq += st }
            st >>= 1
            if diff >= st { code |= 2; diff -= st; dq += st }
            st >>= 1
            if diff >= st { code |= 1; dq += st }
            pred += code & 8 != 0 ? -dq : dq
            pred = min(32767, max(-32768, pred))
            idx = min(88, max(0, idx + idxTab[Int(code & 7)]))
            if i & 1 == 1 { out[1 + i >> 1] |= code << 4 } else { out[1 + i >> 1] = code }
        }
        return Data(out)
    }

    /// ADPCM (ohne Versionsbyte) → 16-Bit-PCM, gleiche Rechnung wie auf der Pebble
    static func decode(_ bytes: Data) -> [Int16] {
        let b = [UInt8](bytes)
        var out = [Int16](repeating: 0, count: b.count * 2)
        var pred: Int32 = 0, idx = 0
        for i in 0..<out.count {
            let code = i & 1 == 1 ? b[i >> 1] >> 4 : b[i >> 1] & 15
            let st = step[idx]
            var dq = st >> 3
            if code & 4 != 0 { dq += st }
            if code & 2 != 0 { dq += st >> 1 }
            if code & 1 != 0 { dq += st >> 2 }
            pred += code & 8 != 0 ? -dq : dq
            pred = min(32767, max(-32768, pred))
            idx = min(88, max(0, idx + idxTab[Int(code & 7)]))
            out[i] = Int16(pred)
        }
        return out
    }

    /// 16-Bit-Mono-PCM als WAV (zum Abspielen mit AVAudioPlayer)
    static func wav(_ pcm: [Int16], rate: Int = 8000) -> Data {
        var d = Data()
        func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        let bytes = UInt32(pcm.count * 2)
        d.append(contentsOf: Array("RIFF".utf8)); u32(36 + bytes); d.append(contentsOf: Array("WAVEfmt ".utf8))
        u32(16); u16(1); u16(1); u32(UInt32(rate)); u32(UInt32(rate * 2)); u16(2); u16(16)
        d.append(contentsOf: Array("data".utf8)); u32(bytes)
        pcm.withUnsafeBytes { d.append(contentsOf: $0) }
        return d
    }
}
