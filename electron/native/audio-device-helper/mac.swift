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
// 출력은 항상 한 줄 JSON (stdout).

import CoreAudio
import Foundation

func printJSONAndExit(_ dict: [String: Any]) -> Never {
    if let data = try? JSONSerialization.data(withJSONObject: dict),
       let str = String(data: data, encoding: .utf8) {
        print(str)
    }
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

// ─── 진입점 ────────────────────────────────────────────────────────────────

let args = CommandLine.arguments
guard args.count >= 2 else {
    printJSONAndExit(["success": false, "error": "usage: audio-device-helper <get|set> [sampleRate] [bufferFrameSize]"])
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

default:
    printJSONAndExit(["success": false, "error": "unknown-command: \(args[1])"])
}
