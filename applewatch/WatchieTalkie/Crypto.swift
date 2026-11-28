import Foundation

/*
 * Ende-zu-Ende-Verschlüsselung, bytegleich zur Pebble-App (watch/src/pkjs/e2e.js, TweetNaCl):
 * - Konto: X25519-Schlüsselpaar, der geheime Schlüssel bleibt im Schlüsselbund der Uhr.
 * - Nachricht: zufälliger Schlüssel K, Text = secretbox(K); K für jeden Empfänger (auch sich selbst) mit box eingepackt.
 * - Sprachnachricht: Audiodaten mit demselben K und eigener Nonce.
 */
extension Data {
    func u8<R>(_ body: (UnsafePointer<UInt8>) -> R) -> R {
        if isEmpty { var z: UInt8 = 0; return body(&z) }
        return withUnsafeBytes { body($0.bindMemory(to: UInt8.self).baseAddress!) }
    }
    static func random(_ n: Int) -> Data {
        var d = Data(count: n)
        d.withUnsafeMutableBytes { wt_random($0.bindMemory(to: UInt8.self).baseAddress!, n) }
        return d
    }
    var b64: String { base64EncodedString() }
}

/// Verschlüsselte Nachricht zum Senden: Umschlag je Empfänger
struct EncOut {
    let n: String, c: String, k: [String: String]
    var json: [String: Any] { ["v": 1, "n": n, "c": c, "k": k] }
}

enum E2E {
    static func publicKey(_ sk: Data) -> Data {
        var pk = Data(count: 32)
        pk.withUnsafeMutableBytes { p in sk.u8 { wt_public_key(p.bindMemory(to: UInt8.self).baseAddress!, $0) } }
        return pk
    }
    static func sha512(_ d: Data) -> Data {
        var h = Data(count: 64)
        h.withUnsafeMutableBytes { p in d.u8 { wt_sha512(p.bindMemory(to: UInt8.self).baseAddress!, $0, d.count) } }
        return h
    }
    static func secretbox(_ m: Data, nonce: Data, key: Data) -> Data {
        var out = Data(count: m.count + 16)
        _ = out.withUnsafeMutableBytes { o in m.u8 { mp in nonce.u8 { np in key.u8 { kp in
            wt_secretbox(o.bindMemory(to: UInt8.self).baseAddress!, mp, m.count, np, kp) } } } }
        return out
    }
    static func secretboxOpen(_ c: Data, nonce: Data, key: Data) -> Data? {
        guard c.count >= 16, nonce.count == 24, key.count == 32 else { return nil }
        var out = Data(count: max(1, c.count - 16))   // leere Nachricht: trotzdem gültiger Puffer
        let r = out.withUnsafeMutableBytes { o in c.u8 { cp in nonce.u8 { np in key.u8 { kp in
            wt_secretbox_open(o.bindMemory(to: UInt8.self).baseAddress!, cp, c.count, np, kp) } } } }
        return r == 0 ? out.prefix(c.count - 16) : nil
    }
    static func box(_ m: Data, nonce: Data, pk: Data, sk: Data) -> Data {
        var out = Data(count: m.count + 16)
        _ = out.withUnsafeMutableBytes { o in m.u8 { mp in nonce.u8 { np in pk.u8 { pp in sk.u8 { sp in
            wt_box(o.bindMemory(to: UInt8.self).baseAddress!, mp, m.count, np, pp, sp) } } } } }
        return out
    }
    static func boxOpen(_ c: Data, nonce: Data, pk: Data, sk: Data) -> Data? {
        guard c.count > 16, nonce.count == 24, pk.count == 32, sk.count == 32 else { return nil }
        var out = Data(count: c.count - 16)
        let r = out.withUnsafeMutableBytes { o in c.u8 { cp in nonce.u8 { np in pk.u8 { pp in sk.u8 { sp in
            wt_box_open(o.bindMemory(to: UInt8.self).baseAddress!, cp, c.count, np, pp, sp) } } } } }
        return r == 0 ? out : nil
    }

    /// Text verschlüsseln für {Name: öffentlicher Schlüssel (Base64)} → Nachricht + Nachrichtenschlüssel (für Audio)
    static func encrypt(_ text: String, to recipients: [String: String], sk: Data) -> (EncOut, Data) {
        let key = Data.random(32), n = Data.random(24)
        let c = secretbox(Data(text.utf8), nonce: n, key: key)
        var k: [String: String] = [:]
        for (name, pkB64) in recipients {
            guard let pk = Data(base64Encoded: pkB64), pk.count == 32 else { continue }
            let nr = Data.random(24)
            k[name] = (nr + box(key, nonce: nr, pk: pk, sk: sk)).b64
        }
        return (EncOut(n: n.b64, c: c.b64, k: k), key)
    }
    /// Nachrichtenschlüssel aus dem eigenen Umschlag (box authentifiziert den Absender)
    static func openKey(_ e: EncIn, senderPk: String, sk: Data) -> Data? {
        guard let env = e.k.flatMap({ Data(base64Encoded: $0) }), env.count >= 40, let pk = Data(base64Encoded: senderPk) else { return nil }
        return boxOpen(env.subdata(in: 24..<env.count), nonce: env.subdata(in: 0..<24), pk: pk, sk: sk)
    }
    static func decrypt(_ e: EncIn, senderPk: String, sk: Data) -> String? {
        guard let key = openKey(e, senderPk: senderPk, sk: sk), let n = Data(base64Encoded: e.n), let c = Data(base64Encoded: e.c),
              let m = secretboxOpen(c, nonce: n, key: key) else { return nil }
        return String(data: m, encoding: .utf8)
    }
    /// Audio: Base64(Nonce ‖ secretbox(Daten, K))
    static func encryptAudio(_ bytes: Data, key: Data) -> String {
        let n = Data.random(24)
        return (n + secretbox(bytes, nonce: n, key: key)).b64
    }
    static func decryptAudio(_ e: EncIn, senderPk: String, sk: Data, audioB64: String) -> Data? {
        guard let key = openKey(e, senderPk: senderPk, sk: sk), let a = Data(base64Encoded: audioB64), a.count >= 40 else { return nil }
        return secretboxOpen(a.subdata(in: 24..<a.count), nonce: a.subdata(in: 0..<24), key: key)
    }
    /// Sicherheitsnummer wie auf der Einstellungsseite: SHA-512, 4 Gruppen à 4 Hex-Zeichen
    static func fingerprint(_ pkB64: String) -> String {
        guard let pk = Data(base64Encoded: pkB64) else { return "" }
        let h = [UInt8](sha512(pk).prefix(8))
        return stride(from: 0, to: 8, by: 2).map { String(format: "%02x%02x", h[$0], h[$0 + 1]) }.joined(separator: " ")
    }
}
