import Foundation

// MARK: - Antworten des Servers (server/server.js)

struct ServerInfo: Decodable { let name: String?; let version: String?; let registration: String?; let textMax: Int?; let audioSec: Int?; let ntfy: String? }
struct Cfg: Decodable { let qr: [String]?; let push: String?; let ntfy: String?; let ntfyUrl: String?; let notify: Bool? }
struct Dev: Decodable { let spk: Bool; let rec: Bool }
struct WTGroup: Decodable, Identifiable, Hashable { let id: String; let title: String; let owner: String; let members: [String]; let invited: [String] }
struct Me: Decodable {
    let name: String; let aliases: [String]?; let cfg: Cfg
    let contacts: [String]; let invitesOut: [String]; let invitesIn: [String]; let blocked: [String]
    let groups: [WTGroup]; let groupInvites: [WTGroup]; let pubKey: String; let dev: Dev?; let server: ServerInfo; let pauseLeft: Int?
}
/// Verschlüsselte Nachricht, wie sie ein Leser bekommt: nur sein eigener Umschlag k
struct EncIn: Decodable, Hashable { let v: Int; let n: String; let c: String; let k: String? }
struct Msg: Decodable, Identifiable, Hashable {
    let id: Int; let f: String; let ts: Double; let e: EncIn?
    let t: String?        // Klartext nur bei Systemnachrichten
    let v: Int?           // 1 = diktiert
    let a: Int?           // Sprachnachricht: Größe der verschlüsselten Audiodaten
    let chat: String?     // nur beim Polling
    var date: Date { Date(timeIntervalSince1970: ts / 1000) }
    var isVoice: Bool { (a ?? 0) > 0 }
    /// Dauer in Sekunden (wie audio.js durationDs: Nonce 24 + MAC 16 + Versionsbyte, 4000 Byte/s)
    var voiceSeconds: Double { max(0.1, Double((a ?? 41) - 41) * 2 / 8000) }
}
struct ChatItem: Decodable, Identifiable, Hashable { let id: String; let title: String; let group: Bool; let unread: Int; let last: Msg? }
struct ChatsResp: Decodable { let seq: Int; let chats: [ChatItem]; let invites: Int }
struct MsgsResp: Decodable { let msgs: [Msg] }
struct PollResp: Decodable { let seq: Int; let msgs: [Msg]; let del: [String]?; let invites: Int; let more: Bool? }
struct KeysResp: Decodable { let keys: [String: String]; let voice: [String]? }
struct RegResp: Decodable { let name: String; let token: String }
struct AudioResp: Decodable { let audio: String }
struct Empty: Decodable {}

struct APIError: LocalizedError {
    let status: Int; let message: String
    var errorDescription: String? { message }
}

// MARK: - HTTP

final class API {
    var base: String
    var token: String?
    init(base: String, token: String?) { self.base = base; self.token = token }

    private let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 45
        c.waitsForConnectivity = false
        return URLSession(configuration: c)
    }()

    func call<T: Decodable>(_ method: String, _ path: String, _ body: [String: Any]? = nil, timeout: TimeInterval = 20) async throws -> T {
        guard let url = URL(string: base.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + path) else { throw APIError(status: 0, message: "Invalid server address") }
        var req = URLRequest(url: url, timeoutInterval: timeout)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("en", forHTTPHeaderField: "Accept-Language")
        if let token { req.setValue("Bearer " + token, forHTTPHeaderField: "Authorization") }
        if let body { req.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, resp): (Data, URLResponse)
        do { (data, resp) = try await session.data(for: req) } catch {
            throw APIError(status: 0, message: (error as? URLError)?.code == .timedOut ? "Server not responding" : "No connection")
        }
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw APIError(status: status, message: msg ?? "Server error \(status)")
        }
        if T.self == Empty.self { return Empty() as! T }
        do { return try JSONDecoder().decode(T.self, from: data) } catch { throw APIError(status: status, message: "Unexpected answer from server") }
    }
}
