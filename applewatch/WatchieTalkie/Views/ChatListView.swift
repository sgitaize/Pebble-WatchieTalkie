import SwiftUI

/// Chatliste: Einladungen oben, dann Chats (neueste zuerst)
struct ChatListView: View {
    @EnvironmentObject var model: AppModel
    @State private var busy = false
    @State private var debugChat: ChatItem?

    var body: some View {
        list
        #if DEBUG
        .navigationDestination(item: $debugChat) { ChatView(cid: $0.id, title: $0.title) }
        .onChange(of: model.chats) { _, c in
            if let o = model.debugOpen, let item = c.first(where: { $0.id == o }) { model.debugOpen = nil; debugChat = item }
        }
        #endif
    }

    private var list: some View {
        List {
            if let s = model.status {
                Text(s).font(.footnote).foregroundStyle(.orange)
            }
            if let me = model.me {
                ForEach(me.invitesIn, id: \.self) { n in
                    NavigationLink { ContactInviteView(name: n) } label: {
                        Label { VStack(alignment: .leading) { Text(n).bold(); Text("Contact request").font(.caption2).foregroundStyle(.secondary) } }
                        icon: { Image(systemName: "person.badge.plus").foregroundStyle(Color.accentColor) }
                    }
                }
                ForEach(me.groupInvites) { g in
                    NavigationLink { GroupInviteView(group: g) } label: {
                        Label { VStack(alignment: .leading) { Text(g.title).bold(); Text("Group invitation").font(.caption2).foregroundStyle(.secondary) } }
                        icon: { Image(systemName: "person.3").foregroundStyle(Color.accentColor) }
                    }
                }
            }
            ForEach(model.chats) { c in
                NavigationLink(value: c) { ChatRow(chat: c) }
            }
            if model.me != nil && model.chats.isEmpty && (model.me?.invitesIn.isEmpty ?? true) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("No chats yet").bold()
                    Text("Add a friend by their username with +. Or try it out with a test message:").font(.footnote).foregroundStyle(.secondary)
                }
                Button {
                    busy = true
                    Task { _ = await model.requestTest(delay: 0); busy = false }
                } label: { Label(busy ? "Sending …" : "Send me a test message", systemImage: "paperplane") }
            }
            if model.me == nil && model.status == nil {
                HStack { Spacer(); ProgressView(); Spacer() }
            }
        }
        .navigationTitle("Chats")
        .navigationDestination(for: ChatItem.self) { ChatView(cid: $0.id, title: $0.title) }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                NavigationLink { SettingsView() } label: { Image(systemName: "gearshape") }
            }
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink { AddContactView() } label: { Image(systemName: "plus") }
            }
        }
    }
}

struct ChatRow: View {
    @EnvironmentObject var model: AppModel
    let chat: ChatItem

    private var preview: String {
        if !chat.group, model.changedKeys.contains(chat.title) { return "⚠︎ Key changed" }
        guard let m = chat.last else { return chat.group ? "Group" : "" }
        let who = model.isMine(m) ? "You: " : (chat.group ? m.f + ": " : "")
        return who + model.text(m)
    }

    var body: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    if chat.group { Image(systemName: "person.3.fill").font(.caption2) }
                    Text(chat.title).bold().lineLimit(1)
                }
                Text(preview).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
            }
            Spacer(minLength: 2)
            if chat.unread > 0 {
                Text("\(chat.unread)").font(.caption2.bold()).padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Capsule().fill(Color.accentColor))
            }
        }
    }
}

/// Kontaktanfrage: annehmen, ablehnen, blockieren
struct ContactInviteView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let name: String
    @State private var error: String?

    var body: some View {
        List {
            Text("\(name) wants to chat with you.").font(.footnote)
            Button { run { await model.acceptContact(name) } } label: { Label("Accept", systemImage: "checkmark") }
            Button { run { await model.removeContact(name) } } label: { Label("Decline", systemImage: "xmark") }
            Button(role: .destructive) { run { await model.block(name) } } label: { Label("Block", systemImage: "hand.raised") }
            if let error { Text(error).font(.footnote).foregroundStyle(.red) }
        }
        .navigationTitle(name)
    }
    private func run(_ f: @escaping () async -> String?) {
        Task { if let e = await f() { error = e } else { dismiss() } }
    }
}

struct GroupInviteView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let group: WTGroup
    @State private var error: String?

    var body: some View {
        List {
            Text("\(group.owner) invited you to the group “\(group.title)”.").font(.footnote)
            Text("Members: " + group.members.joined(separator: ", ")).font(.caption2).foregroundStyle(.secondary)
            Button { run { await model.acceptGroup(group.id) } } label: { Label("Join", systemImage: "checkmark") }
            Button { run { await model.leaveGroup(group.id) } } label: { Label("Decline", systemImage: "xmark") }
            if let error { Text(error).font(.footnote).foregroundStyle(.red) }
        }
        .navigationTitle(group.title)
    }
    private func run(_ f: @escaping () async -> String?) {
        Task { if let e = await f() { error = e } else { dismiss() } }
    }
}

/// Kontakt per Nutzername einladen
struct AddContactView: View {
    @EnvironmentObject var model: AppModel
    @State private var name = ""
    @State private var result: String?
    @State private var ok = false
    @State private var busy = false

    var body: some View {
        List {
            TextField("Username", text: $name).textInputAutocapitalization(.never).autocorrectionDisabled()
            Button {
                busy = true; result = nil
                let n = name.trimmingCharacters(in: .whitespaces).lowercased()
                Task {
                    if let e = await model.invite(n) { result = e; ok = false } else { result = "Invitation sent to \(n)."; ok = true; name = "" }
                    busy = false
                }
            } label: { Label(busy ? "Sending …" : "Send invitation", systemImage: "person.badge.plus") }
            .disabled(name.trimmingCharacters(in: .whitespaces).count < 3 || busy)
            if let result { Text(result).font(.footnote).foregroundStyle(ok ? .green : .red) }
            if let out = model.me?.invitesOut, !out.isEmpty {
                Section("Waiting for answer") {
                    ForEach(out, id: \.self) { n in
                        Text(n).swipeActions { Button(role: .destructive) { Task { _ = await model.removeContact(n) } } label: { Label("Withdraw", systemImage: "xmark") } }
                    }
                }
            }
        }
        .navigationTitle("Add contact")
    }
}
