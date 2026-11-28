import SwiftUI

/// Ein Chat: Nachrichten, unten Sprechen (Diktat/Tastatur), Sprachnachricht, Schnellantworten.
/// Wischen auf einer Nachricht: eigene löschen, fremde melden.
struct ChatView: View {
    @EnvironmentObject var model: AppModel
    @StateObject private var player = VoicePlayer()
    let cid: String
    let title: String
    @State private var error: String?
    @State private var sending = false
    @State private var reportMsg: Msg?
    @State private var loaded = false

    private var msgs: [Msg] { model.messages[cid] ?? [] }
    private var sys: Bool { model.isSys(cid) }
    private var group: Bool { cid.hasPrefix("g.") }
    private var keyWarn: [String] { model.chatNames(cid).filter { model.changedKeys.contains($0) } }

    var body: some View {
        ScrollViewReader { proxy in
            List {
                ForEach(keyWarn, id: \.self) { n in
                    NavigationLink { SafetyView(name: n) } label: {
                        Label("\(n)'s key changed – check the safety number", systemImage: "exclamationmark.shield").font(.footnote).foregroundStyle(.orange)
                    }
                }
                if loaded && msgs.isEmpty {
                    Text(sys ? "Test messages from the server appear here." : "No messages yet. Tap the microphone to speak.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                ForEach(msgs) { m in
                    MessageRow(m: m, cid: cid, group: group, player: player)
                        .id(m.id)
                        .listRowBackground(Color.clear)
                        .swipeActions {
                            if model.isMine(m) {
                                Button(role: .destructive) { Task { error = await model.deleteMessage(cid, m) } } label: { Label("Delete", systemImage: "trash") }
                            } else if m.t == nil {
                                Button { reportMsg = m } label: { Label("Report", systemImage: "exclamationmark.bubble") }.tint(.orange)
                            }
                        }
                }
                if let error {
                    Text(error).font(.footnote).foregroundStyle(.red).listRowBackground(Color.clear)
                }
                if !sys { composer.id("bottom").listRowBackground(Color.clear) }
                else { Color.clear.frame(height: 1).id("bottom").listRowBackground(Color.clear) }
            }
            .onChange(of: msgs.count) { _, _ in withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
            .onAppear { DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { proxy.scrollTo("bottom", anchor: .bottom) } }
            #if DEBUG
            .onChange(of: loaded) { _, _ in
                if ProcessInfo.processInfo.environment["WT_TOP"] != nil, let f = msgs.first {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { proxy.scrollTo(f.id, anchor: .top) }
                }
            }
            #endif
        }
        .navigationTitle(title)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink { ChatInfoView(cid: cid, title: title) } label: { Image(systemName: "info.circle") }
            }
        }
        .sheet(item: $reportMsg) { m in
            ReportView(kind: "message", about: m.f, chat: cid, msg: m.id, text: m.isVoice ? nil : model.text(m))
        }
        .onAppear {
            model.openChat = cid
            Task {
                await model.loadMessages(cid); loaded = true
                #if DEBUG
                if let t = model.debugSend { model.debugSend = nil; error = await model.send(cid, t) }
                if ProcessInfo.processInfo.environment["WT_AUDIOTEST"] != nil, let v = msgs.first(where: { $0.isVoice }) {
                    do { let a = try await model.loadAudio(cid, v); error = "Audio OK: \(a.count) bytes, \(ADPCM.decode(a).count) samples" }
                    catch { self.error = "Audio: " + error.localizedDescription }
                }
                #endif
            }
        }
        .onDisappear { if model.openChat == cid { model.openChat = nil }; player.stop() }
    }

    private var composer: some View {
        HStack(spacing: 6) {
            TextFieldLink(prompt: Text("Message")) {
                Image(systemName: "mic.fill").frame(maxWidth: .infinity)
            } onSubmit: { text in
                sending = true; error = nil
                Task { error = await model.send(cid, text); sending = false }
            }
            .tint(.accentColor)
            if model.voiceOk(cid) {
                NavigationLink { RecordView(cid: cid, title: title) } label: { Image(systemName: "waveform").frame(maxWidth: .infinity) }
            }
            NavigationLink { QuickReplyView(cid: cid) } label: { Image(systemName: "face.smiling").frame(maxWidth: .infinity) }
        }
        .buttonStyle(.bordered)
        .disabled(sending)
        .overlay { if sending { ProgressView() } }
    }
}

struct MessageRow: View {
    @EnvironmentObject var model: AppModel
    let m: Msg
    let cid: String
    let group: Bool
    @ObservedObject var player: VoicePlayer
    @State private var err: String?

    private var mine: Bool { model.isMine(m) }
    private var meta: String {
        let f = DateFormatter()
        f.dateStyle = Calendar.current.isDateInToday(m.date) ? .none : .short
        f.timeStyle = .short
        return f.string(from: m.date) + (m.v == 1 ? " · dictated" : "")
    }

    var body: some View {
        VStack(alignment: mine ? .trailing : .leading, spacing: 2) {
            if !mine && (group || m.t != nil) {
                Text(m.t != nil ? "WatchieTalkie" : m.f).font(.caption2.bold()).foregroundStyle(Color.accentColor)
            }
            Group {
                if m.isVoice { voice } else { Text(model.text(m)).font(.body) }
            }
            .padding(.horizontal, 8).padding(.vertical, 5)
            .background(RoundedRectangle(cornerRadius: 10).fill(mine ? Color.accentColor.opacity(0.45) : Color.gray.opacity(0.3)))
            Text(meta).font(.system(size: 10)).foregroundStyle(.secondary)
            if let err { Text(err).font(.caption2).foregroundStyle(.red) }
        }
        .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
    }

    private var voice: some View {
        Button {
            if player.playingId == m.id { player.stop(); return }
            err = nil
            player.loadingId = m.id
            Task {
                do { let a = try await model.loadAudio(cid, m); player.play(id: m.id, adpcm: a) } catch { err = error.localizedDescription }
                player.loadingId = nil
            }
        } label: {
            HStack(spacing: 6) {
                if player.loadingId == m.id { ProgressView().frame(width: 16, height: 16) }
                else { Image(systemName: player.playingId == m.id ? "stop.fill" : "play.fill") }
                Text("Voice " + fmtDuration(m.voiceSeconds))
            }
        }
        .buttonStyle(.plain)
    }
}

/// Sprachnachricht aufnehmen (bis 30 s), senden oder verwerfen
struct RecordView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @StateObject private var rec = VoiceRecorder()
    let cid: String
    let title: String
    @State private var sending = false
    @State private var error: String?

    var body: some View {
        VStack(spacing: 8) {
            Text(title).font(.footnote).foregroundStyle(.secondary)
            HStack(spacing: 6) {
                if rec.recording { Circle().fill(.red).frame(width: 10, height: 10) }
                Text(fmtDuration(rec.elapsed) + " / 0:30").font(.title3.monospacedDigit())
            }
            ProgressView(value: min(rec.elapsed, VoiceRecorder.maxSeconds), total: VoiceRecorder.maxSeconds)
            if let e = error ?? rec.error { Text(e).font(.footnote).foregroundStyle(.red) }
            Button {
                guard let (data, secs) = rec.stop(keep: true) else { error = "Too short – hold on a little longer"; return }
                sending = true
                Task {
                    if let e = await model.sendVoice(cid, adpcm: data, seconds: secs) { error = e; sending = false } else { dismiss() }
                }
            } label: {
                if sending { ProgressView() } else { Label("Send", systemImage: "paperplane.fill").bold() }
            }
            .tint(.accentColor)
            .disabled(sending || (!rec.recording && rec.elapsed < 0.5))
        }
        .navigationTitle("Voice message")
        .onAppear { rec.start() }
        .onDisappear { if rec.recording { _ = rec.stop(keep: false) } }
    }
}

/// Schnellantworten (aus den Einstellungen des Kontos) und Emojis
struct QuickReplyView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let cid: String
    @State private var error: String?
    private let emoji = ["👍", "😂", "❤️", "😊", "😮", "😢", "🙏", "👋", "🎉", "🤔", "👌", "😴"]

    var body: some View {
        List {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 4)) {
                ForEach(emoji, id: \.self) { e in
                    Button(e) { send(e) }.font(.title3).buttonStyle(.plain)
                }
            }
            ForEach(model.me?.cfg.qr ?? [], id: \.self) { q in
                Button(q) { send(q) }
            }
            if let error { Text(error).font(.footnote).foregroundStyle(.red) }
        }
        .navigationTitle("Quick reply")
    }
    private func send(_ t: String) {
        Task { if let e = await model.send(cid, t) { error = e } else { dismiss() } }
    }
}
