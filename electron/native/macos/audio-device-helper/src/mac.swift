// mac.swift — CoreAudio HAL 헬퍼 (macOS 전용)
//
// Electron 메인 프로세스가 child_process로 이 바이너리를 실행해, 현재 OS 기본 입력 장치
// (사용자가 실행 전에 시스템 환경설정에서 MCHStreamer 등으로 지정해둔 장치)의
// NominalSampleRate / BufferFrameSize를 조회·설정한다. Node <-> CoreAudio를 직접 잇는
// 코드가 없어서(Web/WASM 샌드박스는 이 프로퍼티에 접근 불가) 별도 컴파일 바이너리로 분리했다.
//
// 사용법:
//   audio-device-helper list
//   audio-device-helper get          [--device <UID>]
//   audio-device-helper query        [--device <UID>]
//   audio-device-helper set          [--device <UID>] <sampleRate> <bufferFrameSize>
//   audio-device-helper capture      [--device <UID>] <sampleRate> <bufferFrameSize> [channels=2]
//   audio-device-helper play-capture [--device <UID>] --ref <path> [--out-ch <n>] <sampleRate> <bufferFrameSize> [channels=2]
//
// --device <UID>가 없으면 OS 기본 입력 장치를 대상으로 한다(기존 동작).
// --out-ch <n>(play-capture 전용, 생략 시 0)는 --ref 신호를 내보낼 출력 채널 인덱스 —
// 멀티채널 앰프 구성에서 ch0이 아닌 다른 출력 채널로 라우팅할 때 쓴다. 장치의 실제 출력
// 채널 수(outputChannelCount) 밖이면 invalid-out-ch 에러로 종료한다.
// play-capture는 입출력 겸용 단일 장치에 IOProc 하나를 열어 --ref 전체(파일 모드 재생 음원을
// 렌더러가 mono로 디코드한 것, raw little-endian Float32)를 처음부터 끝까지 출력 채널
// (--out-ch, 기본 ch0)로 재생하며 입력을 capture 모드와 동일한 int16 스트림으로 내보낸다.
// stdin 라인 명령(pause/resume/stop)으로 제어하고, 재생이 끝나면(+감쇠 테일) exit 0으로
// 스스로 종료한다 — exit 0 = "재생 완료" 신호.
// list는 연결된 입력 장치 전체를 UID/이름/채널과 함께 반환한다(장치 선택 드롭다운용).
// get/set 출력은 한 줄 JSON (stdout).
// capture는 상주 모드: 첫 줄 JSON 헤더 → 이후 stdout은 int16 인터리브 raw PCM 스트림.
// BufferFrameSize는 그 I/O를 실제로 여는 클라이언트가 주인(TN2321)이라 1회성 set으로는
// 유지되지 않는다 — capture 모드는 자기 자신이 IOProc을 열어 값을 붙잡는 것이 핵심.
// 종료: SIGTERM/SIGINT 또는 stdin EOF(부모 Electron 종료 시 파이프가 닫힘).

import CoreAudio
import Foundation

func writeJSONLine(_ dict: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: dict),
       let str = String(data: data, encoding: .utf8) {
        // print()의 stdio 버퍼와 raw PCM(write(2))의 순서가 섞이지 않도록 fd에 직접 쓴다
        FileHandle.standardOutput.write((str + "\n").data(using: .utf8)!)
    }
}

func printJSONAndExit(_ dict: [String: Any]) -> Never {
    writeJSONLine(dict)
    exit(0)
}

func defaultInputDevice() -> AudioDeviceID? {
    var deviceID = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &deviceID)
    return status == noErr ? deviceID : nil
}

func deviceName(_ device: AudioDeviceID) -> String {
    var name: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<CFString?>.size)
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceNameCFString,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    let status = withUnsafeMutablePointer(to: &name) { ptr -> OSStatus in
        AudioObjectGetPropertyData(device, &address, 0, nil, &size, ptr)
    }
    guard status == noErr, let cfName = name?.takeRetainedValue() else { return "" }
    return cfName as String
}

// 재연결(USB 재삽입) 후에도 안정적인 장치 식별자 — 앱은 이 UID를 저장해 장치를 다시 찾는다.
func deviceUID(_ device: AudioDeviceID) -> String {
    var uid: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<CFString?>.size)
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceUID,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    let status = withUnsafeMutablePointer(to: &uid) { ptr -> OSStatus in
        AudioObjectGetPropertyData(device, &address, 0, nil, &size, ptr)
    }
    guard status == noErr, let cfUID = uid?.takeRetainedValue() else { return "" }
    return cfUID as String
}

// 시스템에 연결된 모든 오디오 장치 ID (입력·출력 구분 없이 전부)
func allDeviceIDs() -> [AudioDeviceID] {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var size = UInt32(0)
    let sys = AudioObjectID(kAudioObjectSystemObject)
    guard AudioObjectGetPropertyDataSize(sys, &address, 0, nil, &size) == noErr, size > 0 else { return [] }
    let count = Int(size) / MemoryLayout<AudioDeviceID>.size
    var ids = [AudioDeviceID](repeating: 0, count: count)
    guard AudioObjectGetPropertyData(sys, &address, 0, nil, &size, &ids) == noErr else { return [] }
    return ids
}

// UID로 특정 장치 해석 — 못 찾으면 nil (장치가 뽑혔거나 UID 오타)
func deviceByUID(_ uid: String) -> AudioDeviceID? {
    for id in allDeviceIDs() where deviceUID(id) == uid { return id }
    return nil
}

// 입력 채널이 1개 이상인 장치만 열거 — UI 장치 선택 드롭다운용.
// 각 항목: uid(식별자) · name · inputChannels · sampleRate · isDefault(OS 기본 입력 여부).
func inputDevicesList() -> [[String: Any]] {
    let defID = defaultInputDevice()
    var list: [[String: Any]] = []
    for id in allDeviceIDs() {
        let channels = inputChannelCount(id)
        guard channels > 0 else { continue } // 출력 전용 장치 제외
        list.append([
            "uid": deviceUID(id),
            "name": deviceName(id),
            "inputChannels": channels,
            "sampleRate": getSampleRate(id) as Any,
            "isDefault": defID != nil && id == defID,
        ])
    }
    return list
}

func getSampleRate(_ device: AudioDeviceID) -> Double? {
    var value = Float64(0)
    var size = UInt32(MemoryLayout<Float64>.size)
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyNominalSampleRate,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    let status = AudioObjectGetPropertyData(device, &address, 0, nil, &size, &value)
    return status == noErr ? value : nil
}

func setSampleRate(_ device: AudioDeviceID, _ rate: Double) -> Bool {
    var value = rate
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyNominalSampleRate,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    let size = UInt32(MemoryLayout<Float64>.size)
    return AudioObjectSetPropertyData(device, &address, 0, nil, size, &value) == noErr
}

func getBufferFrameSize(_ device: AudioDeviceID) -> UInt32? {
    var value = UInt32(0)
    var size = UInt32(MemoryLayout<UInt32>.size)
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyBufferFrameSize,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    let status = AudioObjectGetPropertyData(device, &address, 0, nil, &size, &value)
    return status == noErr ? value : nil
}

//BufferSize 지정
func setBufferFrameSize(_ device: AudioDeviceID, _ frames: UInt32) -> Bool {
    var value = frames
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyBufferFrameSize,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    let size = UInt32(MemoryLayout<UInt32>.size)
    return AudioObjectSetPropertyData(device, &address, 0, nil, size, &value) == noErr
}

func bufferFrameSizeRange(_ device: AudioDeviceID) -> (min: UInt32, max: UInt32)? {
    var range = AudioValueRange()
    var size = UInt32(MemoryLayout<AudioValueRange>.size)
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyBufferFrameSizeRange,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    let status = AudioObjectGetPropertyData(device, &address, 0, nil, &size, &range)
    return status == noErr ? (UInt32(range.mMinimum), UInt32(range.mMaximum)) : nil
}

// 장치가 지원하는 이산 SampleRate 목록 (대개 min==max인 이산값; 범위형이면 min·max 둘 다 수록)
func availableSampleRates(_ device: AudioDeviceID) -> [Double] {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyAvailableNominalSampleRates,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var size = UInt32(0)
    guard AudioObjectGetPropertyDataSize(device, &address, 0, nil, &size) == noErr, size > 0 else { return [] }
    let count = Int(size) / MemoryLayout<AudioValueRange>.size
    var ranges = [AudioValueRange](repeating: AudioValueRange(), count: count)
    guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &ranges) == noErr else { return [] }
    var rates: [Double] = []
    for r in ranges {
        rates.append(r.mMinimum)
        if r.mMaximum != r.mMinimum { rates.append(r.mMaximum) }
    }
    return rates
}

// StreamConfiguration의 채널 합 — scope로 입력/출력을 구분한다. 0이면 그 방향 스트림이 없다.
func streamChannelCount(_ device: AudioDeviceID, scope: AudioObjectPropertyScope) -> Int {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyStreamConfiguration,
        mScope: scope,
        mElement: kAudioObjectPropertyElementMain
    )
    var size = UInt32(0)
    guard AudioObjectGetPropertyDataSize(device, &address, 0, nil, &size) == noErr, size > 0 else { return 0 }
    let ablData = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { ablData.deallocate() }
    guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, ablData) == noErr else { return 0 }
    let abl = UnsafeMutableAudioBufferListPointer(ablData.assumingMemoryBound(to: AudioBufferList.self))
    var channels = 0
    for buf in abl { channels += Int(buf.mNumberChannels) }
    return channels
}

// 입력 스코프 채널 합 — 0이면 출력 전용 장치 (list/query 용, 기존 호출부 호환)
func inputChannelCount(_ device: AudioDeviceID) -> Int {
    streamChannelCount(device, scope: kAudioObjectPropertyScopeInput)
}

// 출력 스코프 채널 합 — 0이면 입력 전용 장치. play-capture 모드가 출력 가능 여부 확인에 쓴다.
func outputChannelCount(_ device: AudioDeviceID) -> Int {
    streamChannelCount(device, scope: kAudioObjectPropertyScopeOutput)
}

// NominalSampleRate 반영은 비동기 — 목표값이 될 때까지 폴링 후 최종값 반환
func waitForSampleRate(_ device: AudioDeviceID, _ target: Double, timeoutMs: Int = 2000) -> Double {
    for _ in 0..<(timeoutMs / 50) {
        if let rate = getSampleRate(device), abs(rate - target) < 1 { return rate }
        usleep(50_000)
    }
    return getSampleRate(device) ?? 0
}

// 장치가 뽑히면(USB 분리 등) kAudioDevicePropertyDeviceIsAlive가 0으로 바뀐다. 리스너 없이는
// IOProc이 그냥 데이터가 안 들어오는 채로 조용히 멈추고(부모/렌더러는 아무 신호도 못 받음),
// 사용자가 직접 정지 버튼을 누를 때까지 화면이 그대로 얼어붙는다 — 이 리스너로 그 순간을 잡아
// onDisconnect를 부른다(호출부는 특정 종료 코드로 stopAndExit해 "크래시"와 구분되게 한다).
func installDeviceIsAliveListener(device: AudioDeviceID, onDisconnect: @escaping () -> Void) {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceIsAlive,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    let listenerBlock: AudioObjectPropertyListenerBlock = { _, _ in
        var isAlive = UInt32(1)
        var size = UInt32(MemoryLayout<UInt32>.size)
        let status = AudioObjectGetPropertyData(device, &address, 0, nil, &size, &isAlive)
        if status != noErr || isAlive == 0 {
            onDisconnect()
        }
    }
    AudioObjectAddPropertyListenerBlock(device, &address, DispatchQueue.main, listenerBlock)
}

// ─── 상주 모드(capture/play-capture) 공유 헬퍼 ─────────────────────────
// 세 모드 모두 "장치 설정 적용 → IOProc 열기 → int16 변환해 stdout 스트리밍 → 시그널/stdin
// 감시로 종료"라는 같은 골격을 쓴다. 모드별 차이는 IOBlock의 출력 채우기 방식뿐.

// installResidentLifecycle이 등록한 DispatchSource들은 함수가 반환된 뒤에도 살아 있어야
// 하므로 전역에 붙잡아 둔다(로컬로 두면 해제되면서 핸들러가 풀림).
var gRetainedSources: [Any] = []

// SR 설정(비동기 폴링) + BufferFrameSize를 장치 지원 범위로 clamp해 적용 → 실제 적용값 반환
func applyDeviceConfig(_ device: AudioDeviceID, _ reqRate: Double, _ reqBuffer: UInt32) -> (actualRate: Double, actualBuffer: UInt32?) {
    _ = setSampleRate(device, reqRate)
    let actualRate = waitForSampleRate(device, reqRate)
    var applyBuffer = reqBuffer
    if let range = bufferFrameSizeRange(device) {
        applyBuffer = min(max(reqBuffer, range.min), range.max)
    }
    _ = setBufferFrameSize(device, applyBuffer)
    return (actualRate, getBufferFrameSize(device))
}

// 이번 IO 사이클의 프레임 수 — 입력 ABL 우선, 없으면 출력 ABL에서 유도 (play-capture용)
func cycleFrameCount(_ inInputData: UnsafePointer<AudioBufferList>, _ outOutputData: UnsafeMutablePointer<AudioBufferList>) -> Int {
    let inABL = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inInputData))
    if inABL.count > 0, inABL[0].mData != nil {
        let ch = max(1, Int(inABL[0].mNumberChannels))
        return Int(inABL[0].mDataByteSize) / (ch * 4)
    }
    let outABL = UnsafeMutableAudioBufferListPointer(outOutputData)
    if outABL.count > 0 {
        let ch = max(1, Int(outABL[0].mNumberChannels))
        return Int(outABL[0].mDataByteSize) / (ch * 4)
    }
    return 0
}

// 입력 ABL의 앞쪽 outChannels개 채널을 Float32 → int16 인터리브로 변환.
// 버퍼가 여러 개면(비인터리브 스트림) 버퍼 순서대로 전역 채널 번호를 매긴다.
// 모노 장치인데 2ch 이상 요청이면 ch0을 ch1에 복제한다(분석 파이프라인은 2ch 고정).
func int16FromInputABL(_ inInputData: UnsafePointer<AudioBufferList>, framesThis: Int, outChannels: Int) -> [Int16] {
    let inABL = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inInputData))
    var out = [Int16](repeating: 0, count: framesThis * outChannels)
    var deviceCh = 0
    if inABL.count > 0, inABL[0].mData != nil {
        for buf in inABL {
            guard let md = buf.mData else { continue }
            let chans = max(1, Int(buf.mNumberChannels))
            let bufFrames = min(framesThis, Int(buf.mDataByteSize) / (chans * 4))
            let samples = md.assumingMemoryBound(to: Float32.self)
            for ch in 0..<chans {
                let outCh = deviceCh + ch
                guard outCh < outChannels else { break }
                for f in 0..<bufFrames {
                    let v = max(-1.0, min(1.0, samples[f * chans + ch]))
                    out[f * outChannels + outCh] = Int16((v * 32767.0).rounded())
                }
            }
            deviceCh += chans
            if deviceCh >= outChannels { break }
        }
    }
    if deviceCh == 1 && outChannels >= 2 {
        for f in 0..<framesThis { out[f * outChannels + 1] = out[f * outChannels] }
    }
    return out
}

// int16 PCM을 stdout(fd 1)에 직접 쓴다 — 파이프가 닫히면(부모 종료) 즉시 프로세스 종료
func writePCMOrDie(_ samples: [Int16]) {
    samples.withUnsafeBufferPointer { ptr in
        guard let base = ptr.baseAddress else { return }
        if write(1, base, ptr.count * 2) <= 0 { _exit(0) }
    }
}

// IOProc 생성 — 실패 시 에러 JSON을 쓰고 종료
func createIOProcOrExit(_ device: AudioDeviceID, _ ioBlock: @escaping AudioDeviceIOBlock) -> AudioDeviceIOProcID {
    var procID: AudioDeviceIOProcID?
    let status = AudioDeviceCreateIOProcIDWithBlock(&procID, device, nil, ioBlock)
    guard status == noErr, let p = procID else {
        writeJSONLine(["success": false, "error": "ioproc-create-failed(\(status))"])
        exit(1)
    }
    return p
}

// 종료 코드 3 = 장치 연결 해제(disconnect) 감지로 인한 자기 종료. 부모(audio-capture.js/
// audio-playcapture.js)는 이 코드를 그대로 "ended" 이벤트에 실어 렌더러로 넘기고, 렌더러는
// 일반 크래시와 다른 안내 문구를 보여준다(useNativeCapture.ts의 offEnded 참고).
let EXIT_CODE_DEVICE_DISCONNECTED: Int32 = 3

// 상주 모드 공통 종료 처리 설치: SIGTERM/SIGINT + stdin 감시 + 장치 연결 해제 감지. 반환값은
// idempotent한 stopAndExit(code)(IOProc stop/destroy 후 exit(code), 기본 0=정상 종료).
// stdinLineHandler가 nil이면 stdin은 EOF 감시 전용(고아 방지 — 기존 capture 동작).
// non-nil이면 같은 스레드가 stdin을 라인 단위로 잘라 메인 큐에서 핸들러를 부른다
// (play-capture의 pause/resume/stop 제어 채널). EOF 시에는 어느 쪽이든 stopAndExit(0).
func installResidentLifecycle(device: AudioDeviceID, procID: AudioDeviceIOProcID,
                              stdinLineHandler: ((String) -> Void)? = nil) -> (Int32) -> Void {
    var stopped = false
    func stopAndExit(_ code: Int32 = 0) {
        if stopped { return }
        stopped = true
        AudioDeviceStop(device, procID)
        AudioDeviceDestroyIOProcID(device, procID)
        exit(code)
    }

    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)
    let sigTermSrc = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    sigTermSrc.setEventHandler { stopAndExit() }
    sigTermSrc.resume()
    let sigIntSrc = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
    sigIntSrc.setEventHandler { stopAndExit() }
    sigIntSrc.resume()
    gRetainedSources.append(sigTermSrc)
    gRetainedSources.append(sigIntSrc)

    installDeviceIsAliveListener(device: device) { stopAndExit(EXIT_CODE_DEVICE_DISCONNECTED) }

    DispatchQueue.global(qos: .utility).async {
        var pending = Data()
        while true {
            let chunk = FileHandle.standardInput.availableData
            if chunk.isEmpty { break } // EOF = 부모(Electron) 종료
            guard let handler = stdinLineHandler else { continue }
            pending.append(chunk)
            while let nl = pending.firstIndex(of: 0x0a) {
                let lineData = pending.subdata(in: pending.startIndex..<nl)
                pending.removeSubrange(pending.startIndex...nl)
                if let line = String(data: lineData, encoding: .utf8)?
                    .trimmingCharacters(in: .whitespacesAndNewlines), !line.isEmpty {
                    DispatchQueue.main.async { handler(line) }
                }
            }
        }
        DispatchQueue.main.async { stopAndExit() }
    }

    return stopAndExit
}

// ─── capture 모드 ──────────────────────────────────────────────────────────
// 자기 자신이 IOProc을 열어 캡처 I/O의 주인이 됨 → BufferFrameSize가 실제 적용·유지된다.
// 입력 Float32(HAL 가상 포맷) → 앞쪽 outChannels개 채널을 int16 인터리브로 변환해 stdout에 쓴다.

func runCapture(device: AudioDeviceID, sampleRate reqRate: Double, bufferFrames reqBuffer: UInt32, outChannels: Int) -> Never {
    signal(SIGPIPE, SIG_IGN) // 파이프 닫힘은 write() 반환값으로 감지해 직접 종료

    let (actualRate, actualBuffer) = applyDeviceConfig(device, reqRate, reqBuffer)

    let ioBlock: AudioDeviceIOBlock = { _, inInputData, _, _, _ in
        // capture는 입력 전용 — 입력 ABL이 비어 있으면 이 사이클은 건너뛴다(무음도 안 쓴다)
        let abl = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inInputData))
        guard abl.count > 0, abl[0].mData != nil else { return }
        let firstChans = max(1, Int(abl[0].mNumberChannels))
        let frames = Int(abl[0].mDataByteSize) / (firstChans * 4)
        guard frames > 0 else { return }
        writePCMOrDie(int16FromInputABL(inInputData, framesThis: frames, outChannels: outChannels))
    }

    let procID = createIOProcOrExit(device, ioBlock)
    _ = installResidentLifecycle(device: device, procID: procID)

    // 헤더(한 줄 JSON)를 IOProc 시작 전에 써서 바이너리와 섞이지 않게 한다
    writeJSONLine([
        "success": true,
        "device": deviceName(device),
        "deviceUID": deviceUID(device),
        "channels": outChannels,
        "requested": ["sampleRate": reqRate, "bufferSize": reqBuffer],
        "actual": [
            "sampleRate": actualRate,
            "bufferSize": actualBuffer as Any,
        ],
    ])

    let startStatus = AudioDeviceStart(device, procID)
    if startStatus != noErr {
        // 헤더는 이미 성공으로 나갔으므로 종료 코드로 실패를 알린다 (부모가 exit 이벤트로 감지)
        exit(2)
    }

    dispatchMain()
}

// ─── play-capture 모드 (파일 재생 + V/I 캡처, 단일 IOProc) ─────────────────────
// 입력·출력을 모두 가진 단일 장치(예: MCHStreamer)에 IOProc 하나를 열어 --ref 신호 전체
// (렌더러가 재생할 파일을 장치 SR·mono로 디코드한 것)를 출력 채널(--out-ch, 기본 ch0)로
// 처음부터 끝까지 재생하며, 같은 콜백에서 입력(V/I 센스)을 capture 모드와 동일한 int16
// 인터리브 스트림으로 stdout에 쓴다. 단일 IOProc = 단일 클록이므로 재생 프레임과 캡처
// 프레임이 같은 카운터 위에 놓여, 렌더러는 수신 프레임 수만으로 재생 위치를 안다. 출력/
// 입력을 별도 장치로 열면 클록이 달라 이 등식이 깨지므로, 반드시 입출력 겸용 단일 장치여야 한다.
//
// 제어: stdin 라인 명령 "pause"(출력 무음 + playPos 동결, 입력 스트림은 계속) / "resume" /
// "stop"(즉시 종료). 게이트는 렌더러가 담당하므로 pause 중에도 캡처는 흘러야 한다 — WASM
// 온도 상태를 유지한 채 차트만 얼리는 기존 pauseRecording 의미론과 합을 맞춘 설계.
// 종료: 재생 끝(playPos ≥ refLen + 감쇠 테일 0.25 s) 도달 시 exit 0 — "재생 완료" 신호.
// SIGTERM/stdin EOF 종료도 exit 0이지만, 부모(audio-playcapture.js)가 사용자 stop 시에는
// child 참조를 먼저 지워 ended 이벤트 자체를 억제하므로 렌더러에는 재생 완료만 code 0으로 온다.

// --ref 파일(raw little-endian Float32, [-1,1] 정규화 mono)을 읽어 배열로 반환. 실패 시 nil.
func readRefSignal(path: String) -> [Float32]? {
    guard let data = FileManager.default.contents(atPath: path), data.count >= 4 else { return nil }
    let count = data.count / 4
    return data.withUnsafeBytes { raw -> [Float32] in
        Array(raw.bindMemory(to: Float32.self).prefix(count))
    }
}

func runPlayCapture(device: AudioDeviceID, sampleRate reqRate: Double, bufferFrames reqBuffer: UInt32,
                    outChannels: Int, refSignal: [Float32], outputChannel: Int) -> Never {
    signal(SIGPIPE, SIG_IGN)

    let deviceOutChannels = outputChannelCount(device)
    guard deviceOutChannels > 0 else {
        printJSONAndExit(["success": false, "error": "device-has-no-output(play-capture requires an input+output device)"])
    }
    guard outputChannel >= 0 && outputChannel < deviceOutChannels else {
        printJSONAndExit(["success": false, "error": "invalid-out-ch(\(outputChannel) not in 0..<\(deviceOutChannels))"])
    }
    guard !refSignal.isEmpty else {
        printJSONAndExit(["success": false, "error": "empty-ref-signal"])
    }

    let (actualRate, actualBuffer) = applyDeviceConfig(device, reqRate, reqBuffer)
    let fs = actualRate > 0 ? actualRate : reqRate
    let refLen = refSignal.count
    let tailFrames = Int(0.25 * fs) // 마지막 샘플 이후 장치의 감쇠 응답까지 캡처
    let playbackCh = outputChannel  // 참조 신호를 내보낼 출력 채널 — --out-ch(기본 0). 멀티채널
                                     // 앰프 구성에서 ch0이 아닌 다른 출력으로 라우팅할 때 쓴다.

    var playPos = 0
    var paused = false
    var finished = false

    let ioBlock: AudioDeviceIOBlock = { _, inInputData, _, outOutputData, _ in
        let framesThis = cycleFrameCount(inInputData, outOutputData)
        guard framesThis > 0 else { return }

        // ── 출력: 전 채널 무음으로 채운 뒤, 재생 중이면 playbackCh에 ref의 현재 구간을 쓴다 ──
        let outABL = UnsafeMutableAudioBufferListPointer(outOutputData)
        for buf in outABL {
            if let md = buf.mData { memset(md, 0, Int(buf.mDataByteSize)) }
        }
        if !paused && playPos < refLen {
            var outDeviceCh = 0
            for buf in outABL {
                guard let md = buf.mData else { continue }
                let chans = max(1, Int(buf.mNumberChannels))
                let bufFrames = min(framesThis, Int(buf.mDataByteSize) / (chans * 4))
                let samples = md.assumingMemoryBound(to: Float32.self)
                for ch in 0..<chans where outDeviceCh + ch == playbackCh {
                    for f in 0..<bufFrames where playPos + f < refLen {
                        samples[f * chans + ch] = refSignal[playPos + f]
                    }
                }
                outDeviceCh += chans
            }
        }

        // ── 입력: pause 여부와 무관하게 항상 스트리밍(렌더러의 recording/analysis 게이트가 버림) ──
        writePCMOrDie(int16FromInputABL(inInputData, framesThis: framesThis, outChannels: outChannels))

        if !paused {
            playPos += framesThis
            if playPos >= refLen + tailFrames { finished = true }
        }
    }

    let procID = createIOProcOrExit(device, ioBlock)
    var stopFn: ((Int32) -> Void)? = nil
    let stopAndExit = installResidentLifecycle(device: device, procID: procID) { line in
        switch line {
        case "pause": paused = true
        case "resume": paused = false
        case "stop": stopFn?(0)
        default: break // 알 수 없는 명령은 무시(프로토콜 전방 호환)
        }
    }
    stopFn = stopAndExit

    // 재생 완료(finished) 폴링 — IOProc(실시간 스레드)에서 직접 stop을 부르지 않는다.
    let doneTimer = DispatchSource.makeTimerSource(queue: .main)
    doneTimer.schedule(deadline: .now() + 0.05, repeating: 0.025)
    doneTimer.setEventHandler { if finished { doneTimer.cancel(); stopAndExit(0) } }
    doneTimer.resume()

    writeJSONLine([
        "success": true,
        "mode": "play-capture",
        "device": deviceName(device),
        "deviceUID": deviceUID(device),
        "channels": outChannels,
        "requested": ["sampleRate": reqRate, "bufferSize": reqBuffer],
        "actual": ["sampleRate": actualRate, "bufferSize": actualBuffer as Any],
        "refLen": refLen,
        "playbackChannel": playbackCh,
    ])

    let startStatus = AudioDeviceStart(device, procID)
    if startStatus != noErr { exit(2) }

    dispatchMain()
}

// ─── 진입점 ────────────────────────────────────────────────────────────────

// program name을 뺀 인자. `--device <UID>` 옵션은 위치 어디에 있든 먼저 뽑아내
// 위치 인자(sampleRate/bufferFrameSize/channels) 인덱스에 영향을 주지 않게 한다.
var argv = Array(CommandLine.arguments.dropFirst())
var requestedUID: String? = nil
if let idx = argv.firstIndex(of: "--device"), idx + 1 < argv.count {
    requestedUID = argv[idx + 1]
    argv.removeSubrange(idx...(idx + 1))
}
// play-capture 전용: --ref <path> — 렌더러가 리샘플해 넘긴 실제 오디오 참조 신호 파일.
var refPath: String? = nil
if let idx = argv.firstIndex(of: "--ref"), idx + 1 < argv.count {
    refPath = argv[idx + 1]
    argv.removeSubrange(idx...(idx + 1))
}
// play-capture 전용: --out-ch <n> — ref를 내보낼 출력 채널 인덱스(생략 시 0 = ch0).
// 멀티채널 앰프 구성에서 ch0이 아닌 다른 출력으로 라우팅할 때 Calibration UI가 넘긴다.
var requestedOutCh: Int? = nil
if let idx = argv.firstIndex(of: "--out-ch"), idx + 1 < argv.count {
    requestedOutCh = Int(argv[idx + 1])
    argv.removeSubrange(idx...(idx + 1))
}

guard let command = argv.first else {
    printJSONAndExit(["success": false, "error": "usage: audio-device-helper <list|get|query|set|capture|play-capture> [--device <UID>] [sampleRate] [bufferFrameSize] [channels]"])
}

// list는 특정 장치가 필요 없다 — 연결된 입력 장치 전체를 반환
if command == "list" {
    printJSONAndExit(["success": true, "devices": inputDevicesList()])
}

// 장치 해석: --device <UID>가 있으면 그 장치, 없으면 OS 기본 입력 장치(기존 동작)
let device: AudioDeviceID
if let uid = requestedUID {
    guard let resolved = deviceByUID(uid) else {
        printJSONAndExit(["success": false, "error": "device-not-found: \(uid)"])
    }
    device = resolved
} else {
    guard let def = defaultInputDevice() else {
        printJSONAndExit(["success": false, "error": "no-default-input-device"])
    }
    device = def
}

switch command {
case "get":
    printJSONAndExit([
        "success": true,
        "device": deviceName(device),
        "deviceUID": deviceUID(device),
        "actual": [
            "sampleRate": getSampleRate(device) as Any,
            "bufferSize": getBufferFrameSize(device) as Any,
        ],
    ])

case "query":
    // 대상 장치의 능력(capability) 조회 — 현재값 + 지원 SampleRate 목록 + Buffer 범위 + 입력 채널 수.
    // get과 달리 UI가 드롭다운/장치 정보 패널을 채우는 데 쓰는 풍부한 정보를 준다.
    var bufferRange: [String: Any] = [:]
    if let range = bufferFrameSizeRange(device) {
        bufferRange = ["min": range.min, "max": range.max]
    }
    printJSONAndExit([
        "success": true,
        "device": deviceName(device),
        "deviceUID": deviceUID(device),
        "current": [
            "sampleRate": getSampleRate(device) as Any,
            "bufferSize": getBufferFrameSize(device) as Any,
        ],
        "supportedSampleRates": availableSampleRates(device),
        "bufferRange": bufferRange,
        "inputChannels": inputChannelCount(device),
        // 0이면 입력 전용 장치 — play-capture(파일 재생)가 불가능함을 UI가 미리 경고할 수 있다
        "outputChannels": outputChannelCount(device),
    ])

case "set":
    guard argv.count >= 3, let reqRate = Double(argv[1]), let reqBuffer = UInt32(argv[2]) else {
        printJSONAndExit(["success": false, "error": "usage: audio-device-helper set [--device <UID>] <sampleRate> <bufferFrameSize>"])
    }
    let rateApplied = setSampleRate(device, reqRate)
    let bufferApplied = setBufferFrameSize(device, reqBuffer)
    // CoreAudio 프로퍼티 반영이 비동기라 재조회 전 짧게 대기
    usleep(100_000)
    printJSONAndExit([
        "success": rateApplied && bufferApplied,
        "device": deviceName(device),
        "deviceUID": deviceUID(device),
        "requested": ["sampleRate": reqRate, "bufferSize": reqBuffer],
        "actual": [
            "sampleRate": getSampleRate(device) as Any,
            "bufferSize": getBufferFrameSize(device) as Any,
        ],
    ])

case "capture":
    guard argv.count >= 3, let reqRate = Double(argv[1]), let reqBuffer = UInt32(argv[2]) else {
        printJSONAndExit(["success": false, "error": "usage: audio-device-helper capture [--device <UID>] <sampleRate> <bufferFrameSize> [channels]"])
    }
    let outChannels = argv.count >= 4 ? max(1, Int(argv[3]) ?? 2) : 2
    runCapture(device: device, sampleRate: reqRate, bufferFrames: reqBuffer, outChannels: outChannels)

case "play-capture":
    guard argv.count >= 3, let reqRate = Double(argv[1]), let reqBuffer = UInt32(argv[2]) else {
        printJSONAndExit(["success": false, "error": "usage: audio-device-helper play-capture [--device <UID>] --ref <path> [--out-ch <n>] <sampleRate> <bufferFrameSize> [channels]"])
    }
    guard let path = refPath, let refSignal = readRefSignal(path: path) else {
        printJSONAndExit(["success": false, "error": "missing-or-unreadable---ref"])
    }
    let outChannels = argv.count >= 4 ? max(1, Int(argv[3]) ?? 2) : 2
    let outCh = requestedOutCh ?? 0
    runPlayCapture(device: device, sampleRate: reqRate, bufferFrames: reqBuffer,
                   outChannels: outChannels, refSignal: refSignal, outputChannel: outCh)

default:
    printJSONAndExit(["success": false, "error": "unknown-command: \(command)"])
}
