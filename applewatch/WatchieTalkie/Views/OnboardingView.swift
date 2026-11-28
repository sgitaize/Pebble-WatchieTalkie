import SwiftUI

/// Erster Start: Regeln annehmen, Namen wählen, Konto anlegen (Schlüssel entstehen auf der Uhr)
struct OnboardingView: View {
    @EnvironmentObject var model: AppModel
    @State private var name = ""
    @State private var agreed = false
    @State private var busy = false
    @State private var error: String?
    @State private var server = AppModel.defaultServer

    private var cleanName: String {
        name.trimmingCharacters(in: .whitespaces).lowercased().replacingOccurrences(of: " ", with: "_")
    }
    private var nameOk: Bool { cleanName.range(of: "^[a-z0-9][a-z0-9_]{2,15}$", options: .regularExpression) != nil }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                Text("Walkie-talkie for your wrist: speak, send – end-to-end encrypted. Chat with friends on Apple Watch and Pebble.")
                    .font(.footnote)
                TextField("Username", text: $name)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Text(name.isEmpty || nameOk ? "3–16 characters: a–z, 0–9, _" : "Only a–z, 0–9, _ (3–16)")
                    .font(.caption2).foregroundStyle(name.isEmpty || nameOk ? Color.secondary : Color.orange)
                NavigationLink("Community rules") { RulesView() }
                Toggle("I accept the rules", isOn: $agreed).font(.footnote)
                Button {
                    create()
                } label: {
                    if busy { ProgressView() } else { Text("Create account").bold() }
                }
                .tint(.accentColor)
                .disabled(!agreed || !nameOk || busy)
                if let error { Text(error).font(.footnote).foregroundStyle(.red) }
                NavigationLink {
                    ServerView(server: $server)
                } label: {
                    Label("Server", systemImage: "server.rack").font(.footnote)
                }
            }
        }
        .navigationTitle("WatchieTalkie2")
    }

    private func create() {
        busy = true; error = nil
        Task {
            do { try await model.register(name: cleanName, server: server) } catch { self.error = error.localizedDescription }
            busy = false
        }
    }
}

struct RulesView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text("Community rules").font(.headline)
                Text("• No harassment, threats, hate, spam or sexual content involving others without consent.")
                Text("• There is zero tolerance for abusive content or users: accounts that break the rules are removed.")
                Text("• You can report any message or user (swipe a message, or the ⓘ button in a chat) and block people at any time. Reports go to the server operator and are reviewed within 24 hours.")
                Text("• Messages are end-to-end encrypted: the operator can only read a message if you report it and include its text.")
                Text("• Only people you accept as contacts can write to you.")
            }
            .font(.footnote)
        }
        .navigationTitle("Rules")
    }
}

struct ServerView: View {
    @Binding var server: String
    var body: some View {
        Form {
            TextField("Server address", text: $server)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
            Button("Default server") { server = AppModel.defaultServer }
            Text("Everyone on the same server can chat with each other. You can run your own (open source).").font(.caption2)
        }
        .navigationTitle("Server")
    }
}
