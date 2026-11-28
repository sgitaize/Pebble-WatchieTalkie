import SwiftUI

/// Infos zu einem Chat: Sicherheitsnummer, blockieren, melden, Kontakt entfernen / Gruppe verlassen
struct ChatInfoView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let cid: String
    let title: String
    @State private var reportUser: String?
    @State private var confirmBlock = false
    @State private var error: String?

    private var other: String? { cid.hasPrefix("u.") && !model.isSys(cid) ? String(cid.dropFirst(2)) : nil }

    var body: some View {
        List {
            if model.isSys(cid) {
                Text("Messages from the WatchieTalkie2 server, e.g. test messages. Read-only.").font(.footnote)
            }
            if let n = other {
                NavigationLink { SafetyView(name: n) } label: { Label("Safety number", systemImage: "checkmark.shield") }
                Text(model.voiceNames.contains(n) ? "Can receive voice messages" : "Text only (no voice messages)")
                    .font(.caption2).foregroundStyle(.secondary)
                Button { reportUser = n } label: { Label("Report \(n)", systemImage: "exclamationmark.bubble") }
                Button(role: .destructive) { confirmBlock = true } label: { Label("Block \(n)", systemImage: "hand.raised") }
                Button(role: .destructive) { run { await model.removeContact(n) } } label: { Label("Remove contact", systemImage: "person.badge.minus") }
            }
            if let g = model.group(cid) {
                Section("Members") {
                    ForEach(g.members, id: \.self) { n in
                        HStack { Text(n); if n == g.owner { Text("owner").font(.caption2).foregroundStyle(.secondary) } }
                            .swipeActions {
                                if n != model.myName {
                                    Button { reportUser = n } label: { Label("Report", systemImage: "exclamationmark.bubble") }.tint(.orange)
                                    Button(role: .destructive) { run { await model.block(n) } } label: { Label("Block", systemImage: "hand.raised") }
                                }
                            }
                    }
                }
                Text("Swipe a member to report or block them. You won't see messages from people you block.").font(.caption2).foregroundStyle(.secondary)
                Button(role: .destructive) { run { await model.leaveGroup(g.id) } } label: { Label("Leave group", systemImage: "rectangle.portrait.and.arrow.right") }
            }
            if let error { Text(error).font(.footnote).foregroundStyle(.red) }
        }
        .navigationTitle(title)
        .sheet(item: Binding(get: { reportUser.map { IdName(id: $0) } }, set: { reportUser = $0?.id })) { u in
            ReportView(kind: "user", about: u.id, chat: cid, msg: nil, text: nil)
        }
        .confirmationDialog("Block \(other ?? "")?", isPresented: $confirmBlock) {
            Button("Block", role: .destructive) { if let n = other { run { await model.block(n) } } }
        } message: { Text("They can no longer write to you or invite you.") }
    }
    private func run(_ f: @escaping () async -> String?) {
        Task { if let e = await f() { error = e } else { dismiss() } }
    }
}

struct IdName: Identifiable { let id: String }

/// Sicherheitsnummern vergleichen (einmal persönlich) – schließt aus, dass der Server falsche Schlüssel unterschiebt
struct SafetyView: View {
    @EnvironmentObject var model: AppModel
    let name: String
    var body: some View {
        List {
            Section(name) { Text(model.keys[name].map(E2E.fingerprint) ?? "No key yet").font(.body.monospaced()) }
            Section("You") { Text(E2E.fingerprint(model.myPk)).font(.body.monospaced()) }
            Text("Compare these numbers in person (e.g. with the Pebble settings page). If they match, nobody can read along.")
                .font(.caption2).foregroundStyle(.secondary)
            if model.changedKeys.contains(name) {
                Button { model.acceptKey(name) } label: { Label("I checked – accept new key", systemImage: "checkmark.shield") }
            }
        }
        .navigationTitle("Safety number")
    }
}

/// Melden (Nachricht/Nutzer) oder Rückmeldung – geht an den Betreiber des Servers
struct ReportView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let kind: String          // "message", "user", "feedback"
    let about: String?
    let chat: String?
    let msg: Int?
    let text: String?
    @State private var includeText = true
    @State private var done = false
    @State private var busy = false
    @State private var error: String?

    private let reasons = ["Spam", "Harassment or threats", "Hate or violence", "Sexual or inappropriate content", "Something else"]

    var body: some View {
        NavigationStack {
            List {
                if done {
                    Text(kind == "feedback" ? "Thanks! Your message was sent." : "Thanks – the operator will review this within 24 hours.").font(.footnote)
                    if let about, kind != "feedback", !(model.me?.blocked.contains(about) ?? false) {
                        Button(role: .destructive) { Task { _ = await model.block(about); dismiss() } } label: { Label("Also block \(about)", systemImage: "hand.raised") }
                    }
                    Button("Done") { dismiss() }
                } else if kind == "feedback" {
                    Text("Feedback, a problem or a question? Write or dictate it – it goes to the server operator.").font(.footnote)
                    TextFieldLink(prompt: Text("Your message")) { Label("Write message", systemImage: "square.and.pencil") } onSubmit: { t in
                        send(reason: "", text: t)
                    }
                } else {
                    if let about { Text(kind == "message" ? "Report this message from \(about)?" : "Report \(about)?").font(.footnote) }
                    if let text, kind == "message" {
                        Text("“\(text)”").font(.caption2).foregroundStyle(.secondary).lineLimit(4)
                        Toggle("Include text", isOn: $includeText).font(.footnote)
                    }
                    ForEach(reasons, id: \.self) { r in
                        Button(r) { send(reason: r, text: includeText ? text : nil) }.disabled(busy)
                    }
                    Text("Messages are end-to-end encrypted: only the text you include here is shown to the operator.").font(.caption2).foregroundStyle(.secondary)
                }
                if busy { ProgressView() }
                if let error { Text(error).font(.footnote).foregroundStyle(.red) }
            }
            .navigationTitle(kind == "feedback" ? "Feedback" : "Report")
        }
    }
    private func send(reason: String, text: String?) {
        busy = true; error = nil
        Task {
            error = await model.report(kind: kind, about: about, chat: chat, msg: msg, text: text, reason: reason)
            busy = false
            if error == nil { done = true }
        }
    }
}

struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    @State private var feedback = false
    @State private var confirmDelete = false
    @State private var error: String?

    var body: some View {
        List {
            if let me = model.me {
                Section("Account") {
                    LabeledContent("Name", value: me.name)
                    NavigationLink { MySafetyView() } label: { Label("My safety number", systemImage: "checkmark.shield") }
                }
            }
            NavigationLink { NotificationsView() } label: { Label("Notifications", systemImage: "bell.badge") }
            NavigationLink { BlockedView() } label: { Label("Blocked", systemImage: "hand.raised") }
            Button { feedback = true } label: { Label("Send feedback", systemImage: "envelope") }
            NavigationLink { RulesView() } label: { Label("Community rules", systemImage: "list.bullet.clipboard") }
            Section("Server") {
                Text(model.server.replacingOccurrences(of: "https://", with: "")).font(.footnote)
                if let v = model.me?.server.version { Text("Version " + v + " · open source").font(.caption2).foregroundStyle(.secondary) }
            }
            Button(role: .destructive) { confirmDelete = true } label: { Label("Delete account", systemImage: "trash") }
            if let error { Text(error).font(.footnote).foregroundStyle(.red) }
            Text("WatchieTalkie2 " + (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "")).font(.caption2).foregroundStyle(.secondary)
        }
        .navigationTitle("Settings")
        .sheet(isPresented: $feedback) { ReportView(kind: "feedback", about: nil, chat: nil, msg: nil, text: nil) }
        .confirmationDialog("Delete your account?", isPresented: $confirmDelete) {
            Button("Delete", role: .destructive) { Task { error = await model.deleteAccount() } }
        } message: { Text("Your contacts, groups and messages are removed from the server. This can't be undone.") }
    }
}

struct MySafetyView: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        List {
            Text(E2E.fingerprint(model.myPk)).font(.title3.monospaced())
            Text("Friends see this number for you. Compare it once in person.").font(.caption2).foregroundStyle(.secondary)
        }
        .navigationTitle("Safety number")
    }
}

struct BlockedView: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        List {
            let b = model.me?.blocked ?? []
            if b.isEmpty { Text("Nobody blocked.").font(.footnote).foregroundStyle(.secondary) }
            ForEach(b, id: \.self) { n in
                HStack { Text(n); Spacer(); Button("Unblock") { Task { _ = await model.unblock(n) } }.font(.footnote) }
            }
        }
        .navigationTitle("Blocked")
    }
}

/// Benachrichtigungen, wenn die App zu ist: über ntfy (kostenlose App fürs iPhone, spiegelt auf die Uhr)
struct NotificationsView: View {
    @EnvironmentObject var model: AppModel
    @State private var busy = false
    @State private var info: String?
    @State private var error: String?

    private var topic: String? { model.me?.cfg.push == "ntfy" ? model.me?.cfg.ntfy : nil }
    private var host: String { (model.me?.cfg.ntfyUrl?.isEmpty == false ? model.me?.cfg.ntfyUrl : model.me?.server.ntfy) ?? "https://ntfy.sh" }

    var body: some View {
        List {
            Text("While the app is open, new messages arrive right away. When it's closed, the server can send a short notice (“New message: name”, never the content) via the free ntfy app on your iPhone – it shows up on your watch like any notification.")
                .font(.caption2)
            if let topic {
                Section("Set up on your iPhone") {
                    Text("1. Install “ntfy” from the App Store").font(.footnote)
                    Text("2. Tap + and subscribe to this topic:").font(.footnote)
                    Text(topic).font(.body.monospaced().bold())
                    Text("Server: " + host.replacingOccurrences(of: "https://", with: "")).font(.caption2).foregroundStyle(.secondary)
                    Text("3. Allow notifications").font(.footnote)
                    Text("Keep the topic secret – whoever knows it sees when you get messages.").font(.caption2).foregroundStyle(.secondary)
                }
                Button {
                    busy = true; error = nil
                    Task {
                        error = await model.requestTest(delay: 20)
                        if error == nil { info = "Test sent in 20 s – close the app now." }
                        busy = false
                    }
                } label: { Label("Test notification", systemImage: "bell") }
                Button(role: .destructive) { run { await model.notificationsOff() } } label: { Label("Turn off", systemImage: "bell.slash") }
            } else {
                if let p = model.me?.cfg.push, !p.isEmpty { Text("Currently set up: \(p) (from the Pebble settings page).").font(.footnote) }
                Button { run { await model.setupNtfy() } } label: { Label("Set up ntfy", systemImage: "bell.badge") }.disabled(busy)
            }
            if let info { Text(info).font(.footnote).foregroundStyle(.green) }
            if let error { Text(error).font(.footnote).foregroundStyle(.red) }
        }
        .navigationTitle("Notifications")
    }
    private func run(_ f: @escaping () async -> String?) {
        busy = true; error = nil
        Task { error = await f(); busy = false }
    }
}
