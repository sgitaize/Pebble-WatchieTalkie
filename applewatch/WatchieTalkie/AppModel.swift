import Foundation
import SwiftUI
import WatchKit

/// Zustand der App: Konto, Chats, Nachrichten, Schlüssel. Spricht mit dem WatchieTalkie2-Server (gleiche API wie die Pebble-App).
@MainActor
final class AppModel: ObservableObject {
    static let defaultServer = "https://watchietalkie.aize-it.de"
    static let sysChat = "u.watchietalkie"
    static let textMax = 300

    @Published var me: Me?
    @Published var chats: [ChatItem] = []
    @Published var messages: [String: [Msg]] = [:]
    @Published var keys: [String: String] = [:]
    @Published var voiceNames: [String] = []
    @Published var changedKeys: Set<String> = []
    @Published var status: String?
    @Published var setUp: Bool

    let api: API
    private var sk: Data?
    private var seq = -1
    private var lastInvites = 0
    private var pollTask: Task<Void, Never>?
    private var plain: [Int: String] = [:]      // entschlüsselte Texte (Nachrichten-Nummer → Text)
    var openChat: String?

    var server: String { api.base }
    var myName: String { me?.name ?? "" }
    var myPk: String { sk.map { E2E.publicKey($0).b64 } ?? "" }

    init() {
        let server = UserDefaults.standard.string(forKey: "wt.server") ?? Self.defaultServer
        let token = Keychain.get("token").flatMap { String(data: $0, encoding: .utf8) }
        sk = Keychain.get("sk")
        api = API(base: server, token: token)
        setUp = token != nil && sk?.count == 32
        #if DEBUG
        // Nur für Tests im Simulator: vorbereitetes Konto übernehmen (SIMCTL_CHILD_WT_SERVER/_TOKEN/_SK)
        let env = ProcessInfo.processInfo.environment
        if let s = env["WT_SERVER"], let t = env["WT_TOKEN"], let k = env["WT_SK"].flatMap({ Data(base64Encoded: $0) }) {
            api.base = s; api.token = t; sk = k; setUp = true
            Keychain.set("token", Data(t.utf8)); Keychain.set("sk", k); UserDefaults.standard.set(s, forKey: "wt.server")
        }
        debugOpen = env["WT_OPEN"]; debugSend = env["WT_SEND"]
        #endif
    }
    #if DEBUG
    var debugOpen: String?, debugSend: String?
    #endif

    // MARK: Konto

    func register(name: String, server: String) async throws {
        api.base = server
        api.token = nil
        UserDefaults.standard.set(server, forKey: "wt.server")
        let r: RegResp = try await api.call("POST", "/v1/register", ["name": name])
        let newSk = Data.random(32)
        Keychain.set("sk", newSk)
        Keychain.set("token", Data(r.token.utf8))
        sk = newSk
        api.token = r.token
        seq = -1
        setUp = true
        await refresh()
        startPolling()
    }

    func deleteAccount() async -> String? {
        do { let _: Empty = try await api.call("DELETE", "/v1/me") } catch let e as APIError where e.status != 401 { return e.message } catch {}
        stopPolling()
        Keychain.set("token", nil); Keychain.set("sk", nil)
        UserDefaults.standard.removeObject(forKey: "wt.pins")
        sk = nil; api.token = nil; me = nil; chats = []; messages = [:]; keys = [:]; plain = [:]; seq = -1
        setUp = false
        return nil
    }

    // MARK: Laden

    func becameActive() {
        guard setUp else { return }
        Task { await refresh(); if let c = openChat { await loadMessages(c) }; startPolling() }
    }

    func refresh() async {
        do {
            var m: Me = try await api.call("GET", "/v1/me")
            // im Hintergrund: eigener Schlüssel und „Uhr hat Lautsprecher und Mikrofon“ (Sprachnachrichten)
            if m.pubKey != myPk || m.dev?.spk != true || m.dev?.rec != true {
                m = try await api.call("PUT", "/v1/me", ["pubKey": myPk, "dev": ["spk": true, "rec": true]])
            }
            me = m
            try await loadKeys()
            let c: ChatsResp = try await api.call("GET", "/v1/chats")
            chats = c.chats
            lastInvites = c.invites
            if seq < 0 { seq = c.seq }
            status = nil
        } catch let e as APIError {
            status = e.status == 401 ? "Login no longer valid – delete the account in Settings and set up again." : e.message
        } catch { status = error.localizedDescription }
    }

    /// Öffentliche Schlüssel der Kontakte; ein geänderter Schlüssel wird gemeldet, bis man ihn bestätigt
    private func loadKeys() async throws {
        let r: KeysResp = try await api.call("GET", "/v1/keys")
        keys = r.keys
        voiceNames = r.voice ?? []
        var pins = UserDefaults.standard.dictionary(forKey: "wt.pins") as? [String: String] ?? [:]
        var changed = Set<String>()
        for (n, pk) in r.keys where n != myName {
            if let old = pins[n] { if old != pk { changed.insert(n) } } else { pins[n] = pk }
        }
        UserDefaults.standard.set(pins, forKey: "wt.pins")
        changedKeys = changed
    }
    func acceptKey(_ name: String) {
        var pins = UserDefaults.standard.dictionary(forKey: "wt.pins") as? [String: String] ?? [:]
        pins[name] = keys[name]
        UserDefaults.standard.set(pins, forKey: "wt.pins")
        changedKeys.remove(name)
    }

    func loadMessages(_ cid: String) async {
        do {
            let r: MsgsResp = try await api.call("GET", "/v1/chats/\(cid)/messages?limit=50")
            messages[cid] = r.msgs
            if let last = r.msgs.last { let _: Empty? = try? await api.call("POST", "/v1/chats/\(cid)/read", ["upTo": last.id]) }
            if let i = chats.firstIndex(where: { $0.id == cid }), chats[i].unread > 0 {
                let c = chats[i]; chats[i] = ChatItem(id: c.id, title: c.title, group: c.group, unread: 0, last: c.last)
            }
        } catch let e as APIError { status = e.message } catch {}
    }

    // MARK: Long-Polling (nur solange die App offen ist)

    func startPolling() {
        guard pollTask == nil, setUp else { return }
        pollTask = Task { [weak self] in await self?.pollLoop() }
    }
    func stopPolling() { pollTask?.cancel(); pollTask = nil }

    private func pollLoop() async {
        while !Task.isCancelled && setUp {
            if seq < 0 {
                await refresh()
                if seq < 0 { try? await Task.sleep(nanoseconds: 5_000_000_000); continue }
            }
            do {
                let r: PollResp = try await api.call("GET", "/v1/poll?wait=25&since=\(seq)&invites=\(lastInvites)", timeout: 40)
                let fresh = r.msgs.filter { $0.id > seq }
                seq = max(seq, r.seq)
                let del = r.del ?? []
                if !fresh.isEmpty { WKInterfaceDevice.current().play(.notification) }
                if let oc = openChat, fresh.contains(where: { $0.chat == oc }) || del.contains(oc) { await loadMessages(oc) }
                if !fresh.isEmpty || r.invites != lastInvites || !del.isEmpty { lastInvites = r.invites; await refresh() }
            } catch {
                if Task.isCancelled { break }
                try? await Task.sleep(nanoseconds: 15_000_000_000)
            }
        }
    }

    // MARK: Nachrichten

    func isSys(_ cid: String) -> Bool { cid == Self.sysChat }
    func isMine(_ m: Msg) -> Bool { m.f == myName }

    /// Lesbarer Text einer Nachricht (entschlüsselt, Systemnachrichten im Klartext)
    func text(_ m: Msg) -> String {
        if let t = m.t { return t }
        if m.isVoice { return "Voice message " + fmtDuration(m.voiceSeconds) }
        if let p = plain[m.id] { return p }
        guard let e = m.e, let sk, let pk = isMine(m) ? myPk : keys[m.f] else { return "[unreadable]" }
        guard let t = E2E.decrypt(e, senderPk: pk, sk: sk) else { return "[unreadable]" }
        plain[m.id] = t
        return t
    }

    /// Die anderen Teilnehmer*innen eines Chats
    func chatNames(_ cid: String) -> [String] {
        if cid.hasPrefix("u.") { return [String(cid.dropFirst(2))] }
        return me?.groups.first { "g." + $0.id == cid }?.members.filter { $0 != myName } ?? []
    }
    func group(_ cid: String) -> WTGroup? { me?.groups.first { "g." + $0.id == cid } }

    /// Sprachnachricht möglich: Server erlaubt es und alle Gegenüber können abspielen und aufnehmen
    func voiceOk(_ cid: String) -> Bool {
        guard !isSys(cid), (me?.server.audioSec ?? 0) > 0 else { return false }
        let names = chatNames(cid)
        return !names.isEmpty && names.allSatisfy { voiceNames.contains($0) }
    }

    private func recipients(_ cid: String) throws -> [String: String] {
        let names = chatNames(cid)
        var r = [myName: myPk]
        var missing: [String] = []
        for n in names { if let k = keys[n] { r[n] = k } else { missing.append(n) } }
        if !names.isEmpty && missing.count == names.count {
            throw APIError(status: 0, message: missing.joined(separator: ", ") + " must open WatchieTalkie2 first")
        }
        return r
    }

    func send(_ cid: String, _ text: String, dictated: Bool = false) async -> String? {
        let t = String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(Self.textMax))
        guard !t.isEmpty else { return nil }
        guard !isSys(cid) else { return "This chat is read-only" }
        guard let sk else { return "Not set up" }
        do {
            let (e, _) = E2E.encrypt(t, to: try recipients(cid), sk: sk)
            let _: Empty = try await api.call("POST", "/v1/chats/\(cid)/messages", ["e": e.json, "voice": dictated])
            WKInterfaceDevice.current().play(.success)
            await loadMessages(cid)
            return nil
        } catch { return error.localizedDescription }
    }

    func sendVoice(_ cid: String, adpcm: Data, seconds: Double) async -> String? {
        guard let sk else { return "Not set up" }
        do {
            let (e, key) = E2E.encrypt("\u{1F3A4} Voice message " + fmtDuration(seconds), to: try recipients(cid), sk: sk)
            let audio = E2E.encryptAudio(adpcm, key: key)
            let _: Empty = try await api.call("POST", "/v1/chats/\(cid)/audio", ["e": e.json, "audio": audio], timeout: 60)
            WKInterfaceDevice.current().play(.success)
            await loadMessages(cid)
            return nil
        } catch { return error.localizedDescription }
    }

    /// Audiodaten einer Sprachnachricht holen und entschlüsseln → ADPCM ohne Versionsbyte
    func loadAudio(_ cid: String, _ m: Msg) async throws -> Data {
        let r: AudioResp = try await api.call("GET", "/v1/chats/\(cid)/audio/\(m.id)", timeout: 40)
        guard let e = m.e, let sk, let pk = isMine(m) ? myPk : keys[m.f],
              let b = E2E.decryptAudio(e, senderPk: pk, sk: sk, audioB64: r.audio), b.count > 1, b.first == 1 else {
            throw APIError(status: 0, message: "[unreadable]")
        }
        return b.dropFirst()
    }

    func deleteMessage(_ cid: String, _ m: Msg) async -> String? {
        do { let _: Empty = try await api.call("DELETE", "/v1/chats/\(cid)/messages/\(m.id)"); await loadMessages(cid); return nil }
        catch { return error.localizedDescription }
    }

    // MARK: Kontakte, Gruppen, Blockieren, Melden

    /// Aufruf, der das eigene Konto (meView) zurückgibt
    private func meCall(_ method: String, _ path: String, _ body: [String: Any]? = nil) async -> String? {
        do { me = try await api.call(method, path, body); await refresh(); return nil } catch { return error.localizedDescription }
    }
    func invite(_ name: String) async -> String? { await meCall("POST", "/v1/contacts", ["name": name]) }
    func acceptContact(_ name: String) async -> String? { await meCall("POST", "/v1/contacts/\(name)/accept") }
    func removeContact(_ name: String) async -> String? { await meCall("DELETE", "/v1/contacts/\(name)") }
    func acceptGroup(_ id: String) async -> String? { await meCall("POST", "/v1/groups/\(id)/accept") }
    func leaveGroup(_ id: String) async -> String? { await meCall("DELETE", "/v1/groups/\(id)") }
    func block(_ name: String) async -> String? { await meCall("POST", "/v1/blocks", ["name": name]) }
    func unblock(_ name: String) async -> String? { await meCall("DELETE", "/v1/blocks/\(name)") }

    func report(kind: String, about: String?, chat: String?, msg: Int?, text: String?, reason: String) async -> String? {
        var b: [String: Any] = ["kind": kind, "reason": reason]
        if let about { b["about"] = about }
        if let chat { b["chat"] = chat }
        if let msg { b["msg"] = msg }
        if let text, !text.isEmpty { b["text"] = String(text.prefix(600)) }
        do { let _: Empty = try await api.call("POST", "/v1/report", b); return nil } catch { return error.localizedDescription }
    }

    // MARK: Benachrichtigungen (ntfy), Test

    /// ntfy einrichten: zufälliges Thema (wie ein Passwort), Server schickt dorthin „New message: <Absender>“
    func setupNtfy() async -> String? {
        let abc = Array("abcdefghijkmnpqrstuvwxyz23456789")
        let topic = "wt-" + String(Data.random(20).map { abc[Int($0) % abc.count] })
        return await meCall("PUT", "/v1/me", ["cfg": ["push": "ntfy", "ntfy": topic, "notify": true]])
    }
    func notificationsOff() async -> String? { await meCall("PUT", "/v1/me", ["cfg": ["push": ""]]) }
    func requestTest(delay: Int) async -> String? {
        do { let _: Empty = try await api.call("POST", "/v1/test", ["delay": delay]); if delay == 0 { await refresh() }; return nil }
        catch { return error.localizedDescription }
    }
}

func fmtDuration(_ s: Double) -> String {
    let t = max(1, Int(s.rounded()))
    return String(format: "%d:%02d", t / 60, t % 60)
}
