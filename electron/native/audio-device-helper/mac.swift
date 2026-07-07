// mac.swift — CoreAudio HAL 헬퍼 (macOS 전용)
//
// Electron 메인 프로세스가 child_process로 이 바이너리를 실행해, 현재 OS 기본 입력 장치
// (사용자가 실행 전에 시스템 환경설정에서 MCHStreamer 등으로 지정해둔 장치)의
// NominalSampleRate / BufferFrameSize를 조회·설정한다. Node <-> CoreAudio를 직접 잇는
// 코드가 없어서(Web/WASM 샌드박스는 이 프로퍼티에 접근 불가) 별도 컴파일 바이너리로 분리했다.
//
// 사용법:
//   audio-device-helper get
//   audio-device-helper set <sampleRate> <bufferFrameSize>
//   audio-device-helper capture <sampleRate> <bufferFrameSize> [channels=2]
//
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

// 입력 스코프 StreamConfiguration의 채널 합 — 0이면 출력 전용 장치
func inputChannelCount(_ device: AudioDeviceID) -> Int {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyStreamConfiguration,
        mScope: kAudioObjectPropertyScopeInput,
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

// NominalSampleRate 반영은 비동기 — 목표값이 될 때까지 폴링 후 최종값 반환
func waitForSampleRate(_ device: AudioDeviceID, _ target: Double, timeoutMs: Int = 2000) -> Double {
    for _ in 0..<(timeoutMs / 50) {
        if let rate = getSampleRate(device), abs(rate - target) < 1 { return rate }
        usleep(50_000)
    }
    return getSampleRate(device) ?? 0
}

// ─── capture 모드 ──────────────────────────────────────────────────────────
// 자기 자신이 IOProc을 열어 캡처 I/O의 주인이 됨 → BufferFrameSize가 실제 적용·유지된다.
// 입력 Float32(HAL 가상 포맷) → 앞쪽 outChannels개 채널을 int16 인터리브로 변환해 stdout에 쓴다.

func runCapture(device: AudioDeviceID, sampleRate reqRate: Double, bufferFrames reqBuffer: UInt32, outChannels: Int) -> Never {
    signal(SIGPIPE, SIG_IGN) // 파이프 닫힘은 write() 반환값으로 감지해 직접 종료

    _ = setSampleRate(device, reqRate)
    let actualRate = waitForSampleRate(device, reqRate)

    //HAL에 값 설정 요청
    var applyBuffer = reqBuffer
    if let range = bufferFrameSizeRange(device) {
        applyBuffer = min(max(reqBuffer, range.min), range.max)
    }
        //값 설정 직후 다시 조회
    _ = setBufferFrameSize(device, applyBuffer)
    let actualBuffer = getBufferFrameSize(device)

    let ioBlock: AudioDeviceIOBlock = { _, inInputData, _, _, _ in
        let abl = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inInputData))
        guard abl.count > 0, abl[0].mData != nil else { return }
        let firstChans = max(1, Int(abl[0].mNumberChannels))
        let frames = Int(abl[0].mDataByteSize) / (firstChans * 4)
        guard frames > 0 else { return }

        var out = [Int16](repeating: 0, count: frames * outChannels)
        // 버퍼가 여러 개면(비인터리브 스트림) 버퍼 순서대로 전역 채널 번호를 매긴다
        var deviceCh = 0
        for buf in abl {
            guard let mData = buf.mData else { continue }
            let chans = max(1, Int(buf.mNumberChannels))
            let bufFrames = min(frames, Int(buf.mDataByteSize) / (chans * 4))
            let samples = mData.assumingMemoryBound(to: Float32.self)
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
        // 모노 장치인데 스테레오 요청이면 ch0 복제 (분석 파이프라인은 [L,R] 2ch 고정)
        if deviceCh == 1 && outChannels >= 2 {
            for f in 0..<frames { out[f * outChannels + 1] = out[f * outChannels] }
        }
        out.withUnsafeBufferPointer { ptr in
            guard let base = ptr.baseAddress else { return }
            if write(1, base, ptr.count * 2) <= 0 { _exit(0) } // 파이프 닫힘 = 부모 종료
        }
    }

    var procID: AudioDeviceIOProcID?
    let createStatus = AudioDeviceCreateIOProcIDWithBlock(&procID, device, nil, ioBlock)
    guard createStatus == noErr, procID != nil else {
        writeJSONLine(["success": false, "error": "ioproc-create-failed(\(createStatus))"])
        exit(1)
    }

    var stopped = false
    func stopAndExit() {
        if stopped { return }
        stopped = true
        if let p = procID {
            AudioDeviceStop(device, p)
            AudioDeviceDestroyIOProcID(device, p)
        }
        exit(0)
    }

    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)
    let sigTermSrc = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    sigTermSrc.setEventHandler { stopAndExit() }
    sigTermSrc.resume()
    let sigIntSrc = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
    sigIntSrc.setEventHandler { stopAndExit() }
    sigIntSrc.resume()

    // 부모(Electron)가 죽으면 stdin이 EOF — 고아 프로세스로 남지 않도록 감시
    DispatchQueue.global(qos: .utility).async {
        while !FileHandle.standardInput.availableData.isEmpty {}
        DispatchQueue.main.async { stopAndExit() }
    }

    // 헤더(한 줄 JSON)를 IOProc 시작 전에 써서 바이너리와 섞이지 않게 한다
    writeJSONLine([
        "success": true,
        "device": deviceName(device),
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

// ─── 진입점 ────────────────────────────────────────────────────────────────

let args = CommandLine.arguments
guard args.count >= 2 else {
    printJSONAndExit(["success": false, "error": "usage: audio-device-helper <get|set|capture> [sampleRate] [bufferFrameSize] [channels]"])
}

guard let device = defaultInputDevice() else {
    printJSONAndExit(["success": false, "error": "no-default-input-device"])
}

switch args[1] {
case "get":
    printJSONAndExit([
        "success": true,
        "device": deviceName(device),
        "actual": [
            "sampleRate": getSampleRate(device) as Any,
            "bufferSize": getBufferFrameSize(device) as Any,
        ],
    ])

case "query":
    // 기본 입력 장치의 능력(capability) 조회 — 현재값 + 지원 SampleRate 목록 + Buffer 범위 + 입력 채널 수.
    // get과 달리 UI가 드롭다운/장치 정보 패널을 채우는 데 쓰는 풍부한 정보를 준다.
    var bufferRange: [String: Any] = [:]
    if let range = bufferFrameSizeRange(device) {
        bufferRange = ["min": range.min, "max": range.max]
    }
    printJSONAndExit([
        "success": true,
        "device": deviceName(device),
        "current": [
            "sampleRate": getSampleRate(device) as Any,
            "bufferSize": getBufferFrameSize(device) as Any,
        ],
        "supportedSampleRates": availableSampleRates(device),
        "bufferRange": bufferRange,
        "inputChannels": inputChannelCount(device),
    ])

case "set":
    guard args.count >= 4, let reqRate = Double(args[2]), let reqBuffer = UInt32(args[3]) else {
        printJSONAndExit(["success": false, "error": "usage: audio-device-helper set <sampleRate> <bufferFrameSize>"])
    }
    let rateApplied = setSampleRate(device, reqRate)
    let bufferApplied = setBufferFrameSize(device, reqBuffer)
    // CoreAudio 프로퍼티 반영이 비동기라 재조회 전 짧게 대기
    usleep(100_000)
    printJSONAndExit([
        "success": rateApplied && bufferApplied,
        "device": deviceName(device),
        "requested": ["sampleRate": reqRate, "bufferSize": reqBuffer],
        "actual": [
            "sampleRate": getSampleRate(device) as Any,
            "bufferSize": getBufferFrameSize(device) as Any,
        ],
    ])

case "capture":
    guard args.count >= 4, let reqRate = Double(args[2]), let reqBuffer = UInt32(args[3]) else {
        printJSONAndExit(["success": false, "error": "usage: audio-device-helper capture <sampleRate> <bufferFrameSize> [channels]"])
    }
    let outChannels = args.count >= 5 ? max(1, Int(args[4]) ?? 2) : 2
    runCapture(device: device, sampleRate: reqRate, bufferFrames: reqBuffer, outChannels: outChannels)

default:
    printJSONAndExit(["success": false, "error": "unknown-command: \(args[1])"])
}
