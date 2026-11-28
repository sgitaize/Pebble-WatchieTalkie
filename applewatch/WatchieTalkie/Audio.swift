import AVFoundation
import Foundation

/// Aufnahme über das Mikrofon der Uhr → 8 kHz, 16 Bit → ADPCM (Pebble-Format)
final class VoiceRecorder: NSObject, ObservableObject, AVAudioRecorderDelegate {
    static let maxSeconds: TimeInterval = 30
    @Published var recording = false
    @Published var elapsed: TimeInterval = 0
    @Published var error: String?
    private var recorder: AVAudioRecorder?
    private var timer: Timer?
    private let url = FileManager.default.temporaryDirectory.appendingPathComponent("wt-rec.wav")

    func start() {
        error = nil
        AVAudioApplication.requestRecordPermission { ok in
            DispatchQueue.main.async {
                guard ok else { self.error = "Microphone access denied (Settings → Privacy)"; return }
                self.begin()
            }
        }
    }
    private func begin() {
        do {
            let s = AVAudioSession.sharedInstance()
            try s.setCategory(.playAndRecord, mode: .default)
            try s.setActive(true)
            let settings: [String: Any] = [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16000, AVNumberOfChannelsKey: 1,
                                           AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false]
            try? FileManager.default.removeItem(at: url)
            let r = try AVAudioRecorder(url: url, settings: settings)
            r.delegate = self
            guard r.record(forDuration: Self.maxSeconds) else { error = "Microphone not available"; return }
            recorder = r
            recording = true
            elapsed = 0
            timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
                guard let self, let r = self.recorder else { return }
                self.elapsed = min(Self.maxSeconds, r.currentTime)
            }
        } catch { self.error = "Microphone not available" }
    }
    func audioRecorderDidFinishRecording(_ r: AVAudioRecorder, successfully flag: Bool) {
        DispatchQueue.main.async { self.timer?.invalidate(); self.recording = false }
    }
    /// Beenden; mit `keep` die Aufnahme als ADPCM liefern (nil = zu kurz/Fehler)
    func stop(keep: Bool) -> (Data, Double)? {
        let secs = recorder?.currentTime ?? elapsed
        recorder?.stop()
        recorder = nil
        timer?.invalidate()
        recording = false
        try? AVAudioSession.sharedInstance().setActive(false)
        guard keep else { try? FileManager.default.removeItem(at: url); return nil }
        defer { try? FileManager.default.removeItem(at: url) }
        guard let pcm = Self.load8k(url), pcm.count >= 4000 else { return nil }   // mindestens 0,5 s
        _ = secs
        return (ADPCM.encode(pcm), Double(pcm.count) / ADPCM.rate)
    }
    /// Datei lesen und auf 8 kHz / Int16 / mono umrechnen
    static func load8k(_ url: URL) -> [Int16]? {
        guard let file = try? AVAudioFile(forReading: url),
              let inBuf = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)),
              (try? file.read(into: inBuf)) != nil,
              let outFmt = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: ADPCM.rate, channels: 1, interleaved: true),
              let conv = AVAudioConverter(from: file.processingFormat, to: outFmt) else { return nil }
        let cap = AVAudioFrameCount(Double(inBuf.frameLength) * ADPCM.rate / file.processingFormat.sampleRate) + 1024
        guard let outBuf = AVAudioPCMBuffer(pcmFormat: outFmt, frameCapacity: cap) else { return nil }
        var fed = false
        var err: NSError?
        conv.convert(to: outBuf, error: &err) { _, status in
            if fed { status.pointee = .endOfStream; return nil }
            fed = true; status.pointee = .haveData; return inBuf
        }
        guard err == nil, let p = outBuf.int16ChannelData?[0] else { return nil }
        return Array(UnsafeBufferPointer(start: p, count: Int(outBuf.frameLength)))
    }
}

/// Abspielen über den Lautsprecher der Uhr
final class VoicePlayer: NSObject, ObservableObject, AVAudioPlayerDelegate {
    @Published var playingId: Int?
    @Published var loadingId: Int?
    private var player: AVAudioPlayer?

    func play(id: Int, adpcm: Data) {
        stop()
        let pcm = ADPCM.decode(adpcm)
        do {
            let s = AVAudioSession.sharedInstance()
            try s.setCategory(.playback, mode: .default)
            try s.setActive(true)
            let p = try AVAudioPlayer(data: ADPCM.wav(pcm))
            p.delegate = self
            p.volume = 1
            p.play()
            player = p
            playingId = id
        } catch { playingId = nil }
    }
    func stop() { player?.stop(); player = nil; playingId = nil }
    func audioPlayerDidFinishPlaying(_ p: AVAudioPlayer, successfully flag: Bool) {
        DispatchQueue.main.async { self.playingId = nil; try? AVAudioSession.sharedInstance().setActive(false) }
    }
}
